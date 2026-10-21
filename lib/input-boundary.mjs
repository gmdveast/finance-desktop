export class InputError extends Error {
  constructor(message, status = 400, code = 'VALIDATION') { super(message); this.status = status; this.code = code; }
}
export const invalid = (message) => { throw new InputError(message); };
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Ожидается объект JSON.');
  return value;
}
export function textField(value, max, label, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(`Некорректное поле «${label}» (до ${max} символов).`);
  return value.trim();
}
export function calendarDate(value, minimumYear = 1900) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < minimumYear || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function timestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/);
  return Boolean(match && calendarDate(match[1]) && +match[2] < 24 && +match[3] < 60 && +match[4] < 60
    && (match[5] === 'Z' || (+match[6] <= 14 && +match[7] < 60 && (+match[6] < 14 || +match[7] === 0))) && Number.isFinite(Date.parse(value)));
}
export function numberField(value, { min = 0, max = 1e8, decimals = 6, positive = false, label = 'Сумма' } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') invalid(`Некорректное поле «${label}».`);
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) invalid(`Некорректное поле «${label}».`);
  const number = Number(typeof value === 'string' ? value.replace(',', '.') : value);
  const [mantissa, exponent = '0'] = String(Math.abs(number)).toLowerCase().split('e');
  const fractional = Math.max(0, (mantissa.split('.')[1]?.length || 0) - Number(exponent));
  const significant = mantissa.replace('.', '').replace(/^0+/, '').length;
  if (!Number.isFinite(number) || number < min || number > max || (positive && number <= 0) || fractional > decimals || significant > 15) invalid(`Некорректное поле «${label}»: диапазон ${min}…${max}, до ${decimals} знаков после запятой.`);
  return number;
}
export const rateField = (value) => numberField(value, { min: 1e-12, max: 1e6, decimals: 12, label: 'Курс' });
export function rowId(value, { optional = false, max = 104, min = 5 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isInteger(Number(value)) || +value < min || +value > max) invalid('Некорректный ID счёта/строки.');
  return +value;
}

export function localHttpBoundary(req, _res, next, { allowedBodyTypes = [] } = {}) {
  const host = req.headers.host;
  const allowed = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
  if (!allowed.includes(host) || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)
    || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return next(new InputError('Запрос разрешён только из локального приложения.', 403, 'FORBIDDEN_ORIGIN'));
  const hasBody = req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0;
  const contentType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const bodyTypeAllowed = /^application\/json$/.test(contentType) || allowedBodyTypes.includes(contentType);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && hasBody && !bodyTypeAllowed) return next(new InputError('Недопустимый формат тела запроса.', 415, 'UNSUPPORTED_MEDIA_TYPE'));
  next();
}

export function publicError(error) {
  if (error instanceof InputError) return { status: error.status, code: error.code, error: error.message, retryable: [502, 503].includes(error.status) };
  if (error?.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', error: 'Превышен размер JSON.', retryable: false };
  if (error?.type === 'entity.parse.failed') return { status: 400, code: 'INVALID_JSON', error: 'Некорректный JSON.', retryable: false };
  if (error?.status === 409) return { status: 409, code: error.code || 'CONFLICT', error: 'Данные изменены или реестр требует восстановления. Обновите данные и проверьте состояние книги.', retryable: false };
  if (error?.status === 400) return { status: 400, code: error.code || 'VALIDATION', error: 'Некорректный запрос или выбранный файл.', retryable: false };
  if (error?.status === 502 || error?.name === 'TimeoutError') return { status: 502, code: 'EXTERNAL_SERVICE', error: 'Служба курсов недоступна. Повторите запрос позже.', retryable: true };
  if (error?.status === 503 || ['EACCES', 'EPERM', 'EBUSY', 'ENOSPC'].includes(error?.code)) return { status: 503, code: 'STORAGE_UNAVAILABLE', error: 'Хранилище недоступно: закройте Excel, проверьте свободное место и повторите действие.', retryable: true };
  return { status: 500, code: 'INTERNAL_ERROR', error: 'Внутренняя ошибка. Данные не удалось обработать; проверьте состояние книги.', retryable: false };
}
export function createDiagnostics() {
  const diagnostics = [];
  return {
    diagnose(error) {
      const safe = publicError(error);
      diagnostics.push({ at: new Date().toISOString(), code: safe.code, status: safe.status, retryable: safe.retryable });
      if (diagnostics.length > 100) diagnostics.shift();
      return safe;
    },
    recentDiagnostics: () => diagnostics.map((item) => ({ ...item })),
  };
}
