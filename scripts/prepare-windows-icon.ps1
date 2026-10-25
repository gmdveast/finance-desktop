param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,
  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourceFile = (Resolve-Path -LiteralPath $SourcePath).Path
$destination = [IO.Path]::GetFullPath($DestinationPath)
$destinationDirectory = Split-Path -Parent $destination
if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
  throw "Icon destination directory does not exist: $destinationDirectory"
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[object]]::new()
$sourceImage = [System.Drawing.Image]::FromFile($sourceFile)
try {
  if ($sourceImage.Width -ne $sourceImage.Height) {
    throw 'Finance icon source image must be square.'
  }

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }

      $frameStream = [IO.MemoryStream]::new()
      $writer = [IO.BinaryWriter]::new($frameStream)
      try {
        $maskRowBytes = [int]([Math]::Ceiling($size / 32.0) * 4)
        $pixelBytes = $size * $size * 4
        $maskBytes = $maskRowBytes * $size

        # ICO stores a DIB with its XOR bitmap followed by the AND mask.
        $writer.Write([uint32]40)
        $writer.Write([int32]$size)
        $writer.Write([int32]($size * 2))
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]0)
        $writer.Write([uint32]($pixelBytes + $maskBytes))
        $writer.Write([int32]0)
        $writer.Write([int32]0)
        $writer.Write([uint32]0)
        $writer.Write([uint32]0)

        for ($y = $size - 1; $y -ge 0; $y--) {
          for ($x = 0; $x -lt $size; $x++) {
            $color = $bitmap.GetPixel($x, $y)
            $writer.Write([byte]$color.B)
            $writer.Write([byte]$color.G)
            $writer.Write([byte]$color.R)
            $writer.Write([byte]$color.A)
          }
        }

        $writer.Write([byte[]]::new($maskBytes))
        $frames.Add([pscustomobject]@{ Size = $size; Bytes = $frameStream.ToArray() })
      } finally {
        $writer.Dispose()
        $frameStream.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

$iconStream = [IO.MemoryStream]::new()
$iconWriter = [IO.BinaryWriter]::new($iconStream)
try {
  $iconWriter.Write([uint16]0)
  $iconWriter.Write([uint16]1)
  $iconWriter.Write([uint16]$frames.Count)

  $dataOffset = 6 + (16 * $frames.Count)
  foreach ($frame in $frames) {
    $dimension = if ($frame.Size -eq 256) { [byte]0 } else { [byte]$frame.Size }
    $iconWriter.Write($dimension)
    $iconWriter.Write($dimension)
    $iconWriter.Write([byte]0)
    $iconWriter.Write([byte]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]32)
    $iconWriter.Write([uint32]$frame.Bytes.Length)
    $iconWriter.Write([uint32]$dataOffset)
    $dataOffset += $frame.Bytes.Length
  }

  foreach ($frame in $frames) {
    $iconWriter.Write([byte[]]$frame.Bytes)
  }

  [IO.File]::WriteAllBytes($destination, $iconStream.ToArray())
} finally {
  $iconWriter.Dispose()
  $iconStream.Dispose()
}

Write-Output "Created $destination with icon sizes: $($sizes -join ', ') px."
