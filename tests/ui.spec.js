import { test, expect } from './browser-fixture.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TEST_INSTANT } from './test-clock.mjs';

const scenarios = [];
const scenario = (name, run) => scenarios.push([name, run]);
const englishCatalog = JSON.parse(await readFile(new URL('../public/locales/en.json', import.meta.url), 'utf8'));
const englishPhrases = [...Object.values(englishCatalog.messages), ...Object.values(englishCatalog.fragments)];

async function untranslatedUiText(page, locale = 'en') {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(({ locale, englishPhrases }) => {
    const preserved = '[data-locale-preserve], .operation-note, .operation-category-label, .account-route, .account-name, .category-name, .setting-value, code';
    const hasCyrillic = (value) => /[\u0400-\u04FF]/u.test(value);
    const allowedEnglishWords = /\b(?:Finance|Capture|Sync|Obsidian|Syncthing|GitHub|BRAT|RUB|USD|GEL|API|CSV|XML|JSON|CBR|SHA|URL|ID)\b/giu;
    const normalizeEnglish = (value) => value
      .replace(allowedEnglishWords, ' ')
      .replace(/\{[^}]+\}/gu, ' ')
      .replace(/\d+/gu, ' ')
      .replace(/[^A-Za-z]+/gu, ' ')
      .trim()
      .toLowerCase();
    const englishCandidates = englishPhrases.map(normalizeEnglish).filter((value) => value.length >= 4);
    const isUntranslated = (value) => locale === 'en'
      ? hasCyrillic(value)
      : englishCandidates.some((candidate) => normalizeEnglish(value).includes(candidate));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const strings = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.trim();
      if (!text || !isUntranslated(text) || node.parentElement.closest(preserved)) continue;
      strings.push({ text, tag: node.parentElement.tagName, className: node.parentElement.className });
    }
    for (const element of document.querySelectorAll('[title], [aria-label], [placeholder], [alt], [label]')) {
      if (element.closest(`${preserved}, .keyboard-row`)) continue;
      for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'label']) {
        const value = element.getAttribute(attribute)?.trim();
        if (!value || !isUntranslated(value)) continue;
        if (attribute === 'title' && element.matches('.account-name-cell input[name="name"]')) continue;
        strings.push({ attribute, text: value, tag: element.tagName, className: element.className });
      }
    }
    if (isUntranslated(document.title)) strings.push({ attribute: 'document.title', text: document.title });
    return [...new Map(strings.map((entry) => [`${entry.attribute || 'text'}:${entry.text}`, entry])).values()];
  }, { locale, englishPhrases });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(TEST_INSTANT));
});

scenario('настройки отдельно показывают обновление desktop и Finance Capture через BRAT', async ({ page }) => {
  await page.route('**/api/updates/check', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      currentVersion: '1.0.0-beta.1',
      channel: 'beta',
      update: {
        version: '1.0.0-beta.2',
        channel: 'beta',
        publishedAt: '2026-10-20T10:00:00Z',
        notes: 'Исправления и упрощение обновления.',
        url: 'https://github.com/gmdveast/finance-desktop/releases/tag/v1.0.0-beta.2',
        installerName: 'Finance-Setup-1.0.0-beta.2-x64.exe',
      },
    }),
  }));
  await page.goto('/#settings');
  await expect(page.getByRole('heading', { name: 'Обновление Finance' })).toBeVisible();
  await expect(page.locator('.update-plugin-note')).toContainText('Finance Capture обновляется отдельно');
  await expect(page.locator('.update-plugin-note')).toContainText('Эта проверка desktop не меняет версию плагина');
  const topbarUpdate = page.locator('#topbar-update-notice');
  await page.locator('[data-check-update]').click();
  await expect(page.getByText('Доступна версия 1.0.0-beta.2 (beta).')).toBeVisible();
  await expect(page.getByText('Исправления и упрощение обновления.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Описание выпуска' })).toHaveAttribute('href', 'https://github.com/gmdveast/finance-desktop/releases/tag/v1.0.0-beta.2');
  await expect(page.getByRole('button', { name: 'Скачать и установить' })).toBeVisible();
  await expect(topbarUpdate).toBeVisible();
  await expect(topbarUpdate).toContainText('1.0.0-beta.2');
  await expect(topbarUpdate).toHaveAttribute('aria-label', 'Доступно обновление Finance 1.0.0-beta.2. Открыть настройки обновления.');
  await page.locator('.nav-item[data-view="overview"]').click();
  await expect(topbarUpdate).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowTopbar = await page.evaluate(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const notice = document.querySelector('#topbar-update-notice').getBoundingClientRect();
    const actions = document.querySelector('.topbar-actions').getBoundingClientRect();
    return {
      noticeInsideViewport: notice.left >= 0 && notice.right <= window.innerWidth,
      noticeBeforeActions: notice.right <= actions.left + 1,
      pageFitsViewport: document.documentElement.scrollWidth <= window.innerWidth,
      topbarHeight: bar.height,
    };
  });
  expect(narrowTopbar.noticeInsideViewport).toBeTruthy();
  expect(narrowTopbar.noticeBeforeActions).toBeTruthy();
  expect(narrowTopbar.pageFitsViewport).toBeTruthy();
  expect(narrowTopbar.topbarHeight).toBe(72);
  await topbarUpdate.focus();
  await expect(topbarUpdate).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#content h1')).toHaveText('Настройки');
  await expect(page.locator('[data-install-update]')).toBeFocused();
});

scenario('настройки выравнивают кнопки по нижнему краю; иконки и логотип без ореола', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.locator('.settings-grid')).toBeVisible();
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 });
    const heights = await page.locator('[data-clear-data], [data-check-update]').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    await expect(page.locator('#toast-stack')).toHaveCSS('scrollbar-width', 'none');
  }
  await page.setViewportSize({ width: 420, height: 300 });
  const toastStack = page.locator('#toast-stack');
  await toastStack.evaluate((stack) => {
    for (let i = 0; i < 10; i += 1) {
      const toast = document.createElement('div');
      toast.className = 'toast show';
      toast.innerHTML = `<span class="toast-message">Уведомление ${i}</span><button class="toast-close">×</button>`;
      stack.append(toast);
    }
  });
  const toastScroll = await toastStack.evaluate((stack) => {
    const maxScroll = stack.scrollHeight - stack.clientHeight;
    stack.scrollTop = maxScroll;
    return { maxScroll, scrollTop: stack.scrollTop, overflowY: getComputedStyle(stack).overflowY };
  });
  expect(toastScroll.maxScroll).toBeGreaterThan(0);
  expect(toastScroll.scrollTop).toBeGreaterThan(0);
  expect(toastScroll.overflowY).toBe('auto');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('[data-action="refresh-rates"]')).toBeHidden();
  await expect(page.locator('[data-action="add-operation"]')).toBeHidden();
  const settingsLayout = await page.locator('.settings-grid').evaluate((grid) => [...grid.querySelectorAll(':scope > .settings-card')].map((card) => {
    const actionRows = [...card.children].filter((child) => child.classList.contains('settings-actions'));
    const actions = actionRows.at(-1);
    const note = card.querySelector('.update-plugin-note');
    return {
      actionsAreLast: card.lastElementChild === actions,
      noteBeforeActions: !note || Boolean(note.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING),
      bottomGap: card.getBoundingClientRect().bottom - actions.getBoundingClientRect().bottom,
      actionHeights: [...actions.children].map((control) => control.getBoundingClientRect().height),
    };
  }));
  expect(settingsLayout).toHaveLength(4);
  for (const card of settingsLayout) {
    expect(card.actionsAreLast).toBeTruthy();
    expect(card.noteBeforeActions).toBeTruthy();
    expect(card.bottomGap).toBeGreaterThanOrEqual(20);
    expect(card.bottomGap).toBeLessThan(26);
    expect(card.actionHeights.every((height) => height >= 44)).toBeTruthy();
  }

  const recoveryOrder = await page.locator('.settings-recovery-card').evaluate((card) => {
    const children = [...card.children];
    return {
      actions: children.indexOf(card.querySelector('.settings-actions')),
      status: children.indexOf(card.querySelector('.recovery-status')),
      footnote: children.indexOf(card.querySelector('.recovery-footnote')),
    };
  });
  expect(recoveryOrder.actions).toBeLessThan(recoveryOrder.status);
  expect(recoveryOrder.status).toBeLessThan(recoveryOrder.footnote);

  const recoveryButtonLayout = await page.locator('.settings-recovery-card').evaluate((card) => {
    const actions = card.querySelector('.settings-actions');
    const [verify, rehearse] = actions.children;
    const actionBounds = actions.getBoundingClientRect();
    const verifyBounds = verify.getBoundingClientRect();
    const rehearseBounds = rehearse.getBoundingClientRect();
    return {
      actionsWidth: actionBounds.width,
      buttonWidths: [verifyBounds.width, rehearseBounds.width],
      buttonHeights: [verifyBounds.height, rehearseBounds.height],
      leftGap: verifyBounds.left - actionBounds.left,
      rightGap: actionBounds.right - rehearseBounds.right,
    };
  });
  expect(recoveryButtonLayout.actionsWidth).toBeGreaterThan(620);
  expect(Math.abs(recoveryButtonLayout.buttonWidths[0] - recoveryButtonLayout.buttonWidths[1])).toBeLessThan(0.5);
  expect(recoveryButtonLayout.buttonHeights[0]).toBe(recoveryButtonLayout.buttonHeights[1]);
  expect(recoveryButtonLayout.leftGap).toBe(0);
  expect(recoveryButtonLayout.rightGap).toBe(0);

  await page.locator('.nav-item[data-view="balance"]').click();
  await expect(page.locator('[data-action="refresh-rates"]')).toBeVisible();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  const topbarStyles = await page.locator('.topbar-actions').evaluate((actions) => {
    const buttons = [...actions.querySelectorAll(':scope > button')];
    const icons = buttons.map((button) => button.querySelector('.topbar-icon'));
    return {
      gaps: buttons.map((button) => getComputedStyle(button).gap),
      iconWidths: icons.map((icon) => getComputedStyle(icon).width),
      iconContents: icons.map((icon) => icon.textContent.trim() || (icon.querySelector('svg') ? 'svg' : '')),
    };
  });
  expect(topbarStyles.gaps).toEqual(['8px', '8px']);
  expect(topbarStyles.iconWidths).toEqual(['18px', '18px']);
  expect(topbarStyles.iconContents).toEqual(['↻', 'svg']);

  const logoStyle = await page.locator('.brand-mark').evaluate((mark) => ({
    background: getComputedStyle(mark).backgroundColor,
    blend: getComputedStyle(mark.querySelector('img')).mixBlendMode,
  }));
  expect(logoStyle.background).toBe('rgb(23, 42, 36)');
  expect(logoStyle.blend).toBe('lighten');
});

scenario('фоновая проверка показывает цветной индикатор у настроек, не устанавливая обновление', async ({ page }) => {
  let updateCheckCount = 0;
  let updateCheckFails = false;
  await page.route('**/api/settings', async (route) => {
    const response = await route.fetch();
    const settings = await response.json();
    settings.updates = { ...settings.updates, version: '1.0.0-beta.1', channel: 'beta' };
    await route.fulfill({ response, json: settings });
  });
  await page.route('**/api/updates/check', (route) => {
    updateCheckCount += 1;
    if (updateCheckFails) return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Не удалось проверить обновления. Повторите попытку.' }),
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        currentVersion: '1.0.0-beta.1',
        channel: 'beta',
        update: {
          version: '1.0.0-beta.2',
          channel: 'beta',
          publishedAt: '2026-10-20T10:00:00Z',
          notes: 'Исправления и упрощение обновления.',
          url: 'https://github.com/gmdveast/finance-desktop/releases/tag/v1.0.0-beta.2',
          installerName: 'Finance-Setup-1.0.0-beta.2-x64.exe',
        },
      }),
    });
  });

  await page.goto('/');
  const settingsButton = page.locator('.nav-item[data-view="settings"]');
  const indicator = settingsButton.locator('.nav-update-indicator');
  await expect(settingsButton).toHaveAttribute('data-update-available', 'true');
  await expect(page.locator('#topbar-update-notice')).toBeVisible();
  await expect(page.locator('#topbar-update-notice')).toContainText('1.0.0-beta.2');
  await expect(settingsButton).toHaveAttribute('aria-label', 'Настройки. Доступно обновление Finance 1.0.0-beta.2');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveCSS('background-color', 'rgb(255, 184, 77)');
  const markerAlignment = await page.evaluate(() => {
    const settings = document.querySelector('.nav-item[data-view="settings"]');
    const overview = document.querySelector('.nav-item[data-view="overview"]');
    const updateDot = settings.querySelector('.nav-update-indicator').getBoundingClientRect();
    const overviewButton = overview.getBoundingClientRect();
    const overviewRightPadding = Number.parseFloat(getComputedStyle(overview).paddingRight);
    return {
      updateDotRight: updateDot.right,
      activeDotRight: overviewButton.right - overviewRightPadding,
      activeDotColor: getComputedStyle(overview, '::after').backgroundColor,
    };
  });
  expect(markerAlignment.activeDotColor).toBe('rgb(217, 255, 105)');
  expect(Math.abs(markerAlignment.updateDotRight - markerAlignment.activeDotRight)).toBeLessThan(0.5);
  expect(updateCheckCount).toBe(1);

  await settingsButton.click();
  await expect(page.getByText('Доступна версия 1.0.0-beta.2 (beta).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скачать и установить' })).toBeVisible();
  await expect(settingsButton).toHaveAttribute('data-update-available', 'true');
  expect(await settingsButton.evaluate((button) => getComputedStyle(button, '::after').content)).toBe('none');
  await expect(indicator).toHaveCSS('background-color', 'rgb(255, 184, 77)');
  expect(updateCheckCount).toBe(1);

  const balanceButton = page.locator('.nav-item[data-view="balance"]');
  await balanceButton.click();
  expect(await balanceButton.evaluate((button) => getComputedStyle(button, '::after').backgroundColor)).toBe('rgb(217, 255, 105)');
  await expect(indicator).toHaveCSS('background-color', 'rgb(255, 184, 77)');

  updateCheckFails = true;
  await page.reload();
  const reloadedSettingsButton = page.locator('.nav-item[data-view="settings"]');
  await expect(reloadedSettingsButton).toHaveAttribute('data-update-available', 'true');
  await reloadedSettingsButton.click();
  await expect(page.locator('.settings-update-card .update-error')).toContainText('Не удалось проверить обновления. Повторите попытку.');
  await expect(reloadedSettingsButton).toHaveAttribute('aria-label', 'Настройки. Доступно обновление Finance 1.0.0-beta.2');
  expect(updateCheckCount).toBe(2);
});

scenario('сбой фоновой проверки не показывает ни доступное обновление, ни последнюю версию', async ({ page }) => {
  await page.route('**/api/settings', async (route) => {
    const response = await route.fetch();
    const settings = await response.json();
    settings.updates = { ...settings.updates, version: '1.0.0-beta.1', channel: 'beta' };
    await route.fulfill({ response, json: settings });
  });
  await page.route('**/api/updates/check', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Не удалось проверить обновления. Повторите попытку.' }),
  }));

  await page.goto('/');
  const settingsButton = page.locator('.nav-item[data-view="settings"]');
  await expect(settingsButton).not.toHaveAttribute('data-update-available', 'true');
  await settingsButton.click();
  const indicator = settingsButton.locator('.nav-update-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveCSS('background-color', 'rgb(217, 255, 105)');
  expect(await settingsButton.evaluate((button) => getComputedStyle(button, '::after').content)).toBe('none');
  await expect(page.locator('.settings-update-card .update-error')).toContainText('Не удалось проверить обновления. Повторите попытку.');
  await expect(page.locator('.settings-update-card')).not.toContainText('Установлена последняя доступная версия');
  await expect(page.locator('#topbar-update-notice')).toBeHidden();
  await expect(page.locator('#toast-stack .toast')).toHaveCount(0);
});

scenario('откат версии остаётся доступен в настройках, когда установлена предыдущая версия', async ({ page }) => {
  await page.route('**/api/settings', async (route) => {
    const response = await route.fetch();
    const settings = await response.json();
    settings.updates = { ...settings.updates, version: '1.2.0', rollbackVersion: '1.1.0' };
    await route.fulfill({ response, json: settings });
  });

  await page.goto('/#settings');
  await expect(page.locator('.settings-update-card [data-rollback-version="1.1.0"]')).toHaveText('Вернуть версию 1.1.0');
});

scenario('порядок категорий, валют и необходимости сохраняется и применяется в формах', async ({ page, request }) => {
  const initial = await (await request.get('/api/data')).json();
  await page.goto('/#lists');

  const categoryRows = page.locator('[data-reference-list="categories"] > .reference-row');
  const currencyRows = page.locator('[data-reference-list="currencies"] > .reference-row');
  const necessityRows = page.locator('[data-reference-list="necessities"] > .reference-row');
  const categoryNames = await categoryRows.locator('.category-name-input').evaluateAll((inputs) => inputs.map((input) => input.value));
  const currencyNames = await currencyRows.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value));
  const necessityNames = await necessityRows.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value));

  await categoryRows.nth(0).getByRole('button', { name: 'Переместить категорию ниже' }).click();
  await currencyRows.nth(0).getByRole('button', { name: 'Переместить валюту ниже' }).click();
  await necessityRows.nth(0).getByRole('button', { name: 'Переместить значение необходимости ниже' }).click();
  expect(await categoryRows.locator('.category-name-input').evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual([categoryNames[1], categoryNames[0], ...categoryNames.slice(2)]);
  expect(await currencyRows.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual([currencyNames[1], currencyNames[0], ...currencyNames.slice(2)]);
  expect(await necessityRows.locator('input').evaluateAll((inputs) => inputs.map((input) => input.value))).toEqual([necessityNames[1], necessityNames[0], ...necessityNames.slice(2)]);
  await expect(categoryRows.first().getByRole('button', { name: 'Переместить категорию выше' })).toBeDisabled();

  const listsResponse = page.waitForResponse((response) => response.url().endsWith('/api/lists') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить справочники' }).click();
  const saved = await (await listsResponse).json();
  const movedCategories = [initial.lists.categories[1], initial.lists.categories[0], ...initial.lists.categories.slice(2)];
  const movedCurrencies = [initial.lists.currencies[1], initial.lists.currencies[0], ...initial.lists.currencies.slice(2)];
  const movedNecessities = [initial.lists.necessities[1], initial.lists.necessities[0], ...initial.lists.necessities.slice(2)];
  expect(saved.data.lists.categories.slice(0, movedCategories.length).map((item) => item.name)).toEqual(movedCategories.map((item) => item.name));
  expect(saved.data.lists.currencies).toEqual(movedCurrencies);
  expect(saved.data.lists.necessities).toEqual(movedNecessities);

  await page.getByRole('button', { name: /Новая операция/ }).click();
  const form = page.locator('#operation-dialog');
  const expenseOrder = movedCategories.filter((item) => item.type === 'Расход').map((item) => item.name);
  expect(await form.locator('select[name="category"] option').evaluateAll((options) => options.map((option) => option.value))).toEqual(expenseOrder);
  expect(await form.locator('select[name="currency"] option').evaluateAll((options) => options.map((option) => option.value))).toEqual(movedCurrencies);
  expect(await form.locator('select[name="necessity"] option').evaluateAll((options) => options.map((option) => option.value))).toEqual(movedNecessities);
});

scenario('audit: вкладка накоплений предлагает только вывод и синхронизирует суммы одной валюты', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const main = data.accounts[0];
  const response = await request.post('/api/savings/accounts', { data: { name: 'Audit UI same currency', type: 'Вклад', currency: main.currency, initialCapital: 0 } });
  expect(response.status()).toBe(201);
  const savingId = (await response.json()).result.id;
  try {
    await page.goto('/#savings');
    const form = page.locator('#savings-transfer-form');
    await form.locator('[name="mainAccountId"]').selectOption(String(main.id));
    await form.locator('[name="savingAccountId"]').selectOption(String(savingId));
    await expect(form.locator('[name="direction"]')).toHaveValue('from-savings');
    await expect(form.locator('select[name="direction"]')).toHaveCount(0);
    await form.locator('[name="savingAmount"]').fill('123');
    await expect(form.locator('[name="mainAmount"]')).toHaveValue('123');
    await form.locator('[name="mainAmount"]').fill('456');
    await expect(form.locator('[name="savingAmount"]')).toHaveValue('456');
  } finally {
    expect((await request.delete(`/api/savings/accounts/${savingId}`)).status()).toBe(200);
  }
});

scenario('история накопительного счёта показывает начальный капитал и связанные движения без остатка по строкам', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const main = data.accounts.find((item) => item.active && item.currency === 'RUB') || data.accounts[0];
  const created = await request.post('/api/savings/accounts', { data: { name: 'Savings history UI', type: 'Вклад', currency: main.currency, initialCapital: 250 } });
  expect(created.status()).toBe(201);
  const savingId = (await created.json()).result.id;
  const increase = await request.post(`/api/savings/accounts/${savingId}/increase`, { data: { amount: 12.5, date: '2026-10-14', notes: 'Начислены проценты' } });
  expect(increase.status()).toBe(201);
  const investment = await request.post('/api/operations', { data: {
    date: '2026-10-15', type: 'Инвестиция', amount: 7, currency: main.currency, rate: main.rate,
    accountId: main.id, savingsAccountId: savingId, destinationAmount: 7, notes: 'Пополнение вклада',
  } });
  expect(investment.status()).toBe(201);
  const withdrawal = await request.post('/api/savings/transfers', { data: {
    direction: 'from-savings', savingAccountId: savingId, mainAccountId: main.id,
    savingAmount: 4, mainAmount: 4, date: data.asOfDate,
  } });
  expect(withdrawal.status()).toBe(201);

  await page.goto('/#savings');
  await page.locator(`[data-savings-history="${savingId}"]`).click();
  const dialog = page.locator('#savings-history-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'История: Savings history UI' })).toBeVisible();
  await expect(dialog.locator('#savings-history-balance')).toContainText('265,5');
  const rows = dialog.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(dialog.getByRole('columnheader')).toHaveText(['Дата', 'Тип', 'Заметка', 'Сумма']);
  await expect(dialog).toContainText('Начальный капитал');
  await expect(dialog).toContainText('Капитал на дату создания счёта');
  await expect(dialog).toContainText('Начислены проценты');
  await expect(dialog).toContainText('Пополнение вклада');
  await expect(dialog).toContainText('Перевод в основной учёт');
  await expect(dialog).not.toContainText('Остаток после операции');
  await dialog.locator('[data-close-savings-history]').click();
  await expect(dialog).not.toBeVisible();
});

scenario('тип операции отображается при редактировании, а выбор типа доступен при новом вводе', async ({ page, request }) => {
  const main = (await (await request.get('/api/data')).json()).accounts[0];
  expect((await request.post('/api/savings/accounts', { data: { name: 'Investment guard', type: 'Вклад', currency: 'RUB', initialCapital: 0 } })).status()).toBe(201);
  const created = await request.post('/api/operations', { data: { date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 100, currency: main.currency, rate: main.rate, accountId: main.id, necessity: 'Обязательная' } });
  expect(created.status()).toBe(201);
  const id = (await created.json()).result.id;
  await page.goto('/#operations');
  await page.locator(`[data-edit="${id}"]`).click();
  const dialog = page.locator('#operation-dialog');
  await expect(dialog.locator('.type-switch')).toBeHidden();
  await expect(dialog.getByRole('heading', { name: 'Редактирование: Расход' })).toBeVisible();
  await page.mouse.click(1, 1);
  await expect(dialog).not.toBeVisible();
  await page.locator('[data-action="add-operation"]').click();
  await expect(dialog.locator('.type-switch')).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Инвестиция' })).toBeEnabled();
  await page.mouse.click(1, 1);
  await expect(dialog).not.toBeVisible();
});

scenario('инвестицию и вывод из накоплений можно редактировать из истории операций', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const main = data.accounts.find((item) => item.active && item.currency === 'RUB') || data.accounts[0];
  const savingsResponse = await request.post('/api/savings/accounts', { data: { name: 'Editable savings', type: 'Вклад', currency: 'RUB', initialCapital: 100 } });
  expect(savingsResponse.status()).toBe(201);
  const savingsId = (await savingsResponse.json()).result.id;
  const investmentResponse = await request.post('/api/operations', { data: {
    date: '2026-10-14', type: 'Инвестиция', amount: 10, currency: main.currency, rate: main.rate,
    accountId: main.id, savingsAccountId: savingsId, destinationAmount: 9, notes: 'До редактирования',
  } });
  expect(investmentResponse.status()).toBe(201);
  const investmentId = (await investmentResponse.json()).result.id;
  const withdrawalResponse = await request.post('/api/savings/transfers', { data: {
    direction: 'from-savings', savingAccountId: savingsId, mainAccountId: main.id,
    savingAmount: 4, mainAmount: 300, date: '2026-10-14',
  } });
  expect(withdrawalResponse.status()).toBe(201);
  const withdrawalId = (await withdrawalResponse.json()).result.id;

  await page.goto('/#operations');
  const dialog = page.locator('#operation-dialog');
  await page.locator(`[data-operation-row="${investmentId}"] [data-edit]`).click();
  await expect(dialog.getByRole('heading', { name: 'Редактирование: Инвестиция' })).toBeVisible();
  await expect(dialog.locator('.type-switch')).toBeHidden();
  await expect(dialog.locator('[name="destinationAmount"]')).toHaveValue('9');
  await dialog.locator('[name="date"]').fill('2026-10-13');
  await dialog.locator('[name="amount"]').fill('20');
  await dialog.locator('[name="destinationAmount"]').fill('15');
  await dialog.locator('[name="notes"]').fill('Инвестиция исправлена');
  const editInvestment = page.waitForResponse((response) => response.url().endsWith(`/api/operations/${investmentId}`) && response.request().method() === 'PUT');
  await dialog.locator('#save-operation').click();
  expect((await editInvestment).status()).toBe(200);

  await page.locator(`[data-operation-row="${withdrawalId}"] [data-edit]`).click();
  await expect(dialog.getByRole('heading', { name: 'Редактирование: Перевод из накоплений' })).toBeVisible();
  await expect(dialog.locator('.type-switch')).toBeHidden();
  await expect(dialog.locator('[name="amount"]')).toHaveValue('4');
  await expect(dialog.locator('[name="destinationAmount"]')).toHaveValue('300');
  await dialog.locator('[name="date"]').fill('2026-10-13');
  await dialog.locator('[name="amount"]').fill('5');
  await dialog.locator('[name="destinationAmount"]').fill('450');
  await dialog.locator('[name="notes"]').fill('Вывод исправлен');
  const editWithdrawal = page.waitForResponse((response) => response.url().endsWith(`/api/operations/${withdrawalId}`) && response.request().method() === 'PUT');
  await dialog.locator('#save-operation').click();
  expect((await editWithdrawal).status()).toBe(200);

  const updated = await (await request.get('/api/data')).json();
  const savedInvestment = updated.operations.find((item) => item.id === investmentId);
  const savedWithdrawal = updated.operations.find((item) => item.id === withdrawalId);
  expect(savedInvestment).toMatchObject({ type: 'Инвестиция', amount: 20, savingsAmount: 15, notes: 'Инвестиция исправлена' });
  expect(savedWithdrawal).toMatchObject({ type: 'Перевод', amount: 5, destinationAmount: 450, notes: 'Вывод исправлен' });
  expect(updated.savingsAccounts.find((item) => item.id === savingsId).calculatedBalance).toBe(110);
  expect(updated.accounts.find((item) => item.id === main.id).calculatedBalance).toBe(main.calculatedBalance + 430);
});

scenario('подключение телефона необязательно и показывает готовность справочников без тестовой операции', async ({ page, request }) => {
  await page.goto('/#overview');
  await page.evaluate(() => localStorage.removeItem('finance-phone-setup-checks'));
  const beforeSnapshot = await (await request.get('/api/snapshot')).json();
  const beforeData = await (await request.get('/api/data')).json();
  const published = await request.post('/api/settings/publish-mobile');
  expect(published.ok()).toBeTruthy();
  expect(await published.json()).toMatchObject({ listsPublished: true, balancesPublished: true });
  const afterSnapshot = await (await request.get('/api/snapshot')).json();
  const afterData = await (await request.get('/api/data')).json();
  expect(afterSnapshot.revision).toBe(beforeSnapshot.revision);
  expect(afterData.operations).toHaveLength(beforeData.operations.length);
  const settings = await (await request.get('/api/settings')).json();
  expect(settings.mobileLists.state).toBe('ready');
  expect(settings.mobileLists.accountCount).toBeGreaterThan(0);

  await page.goto('/#phone');
  await expect(page.getByRole('heading', { name: 'Подключить телефон' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'На компьютере подготовлены счета' })).toBeVisible();
  await expect(page.getByText('Подключение телефона можно завершить позже. Принятые с телефона операции импортируются в книгу только на этом компьютере.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть инструкцию' })).toBeVisible();
  await expect(page.locator('.phone-diagnostics')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Новая операция' })).toBeHidden();
  const publishResponse = page.waitForResponse((response) => response.url().endsWith('/api/settings/publish-mobile') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подготовить данные для телефона' }).click();
  expect((await publishResponse).ok()).toBeTruthy();
  await expect(page.locator('#toast-stack')).toContainText('Справочники готовы для Syncthing');

  await page.locator('[data-phone-check="syncthing"]').check();
  await expect(page.locator('.phone-checklist-card .tag')).toHaveText('1 из 3');
  await page.reload();
  await expect(page.locator('[data-phone-check="syncthing"]')).toBeChecked();
  await page.getByRole('button', { name: 'Продолжить позже' }).click();
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.getByRole('heading', { name: /Обзор за/ })).toBeVisible();
});

scenario('старый сервер требует перезапуска вместо ложной ошибки баланса', async ({ page }) => {
  await page.route('**/api/settings/export-mobile', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ exported: true, changed: false, balancesChanged: true }),
  }));
  await page.goto('/#settings');
  const button = page.getByRole('button', { name: 'Обновить данные Obsidian' });
  await button.click();
  await expect(page.locator('#toast-stack')).toContainText('Перезапустите desktop-приложение');
  await expect(page.locator('#toast-stack')).not.toContainText('undefined');
  await expect(page.locator('#toast-stack')).not.toContainText('Не удалось опубликовать балансы');
  await expect(button).toBeEnabled();
});

scenario('кнопка Obsidian импортирует очередь, обновляет desktop и сообщает изменение баланса', async ({ page, request, financeServer }) => {
  const before = await (await request.get('/api/data')).json();
  const account = before.accounts[0];
  const root = financeServer.syncRoot;
  const id = 'e2e-full-sync-button-event';
  const source = path.join(root, 'incoming', `${id}.json`);
  await mkdir(path.dirname(source), { recursive: true });
  await page.goto('/#settings');
  await expect(page.getByRole('button', { name: 'Обновить данные Obsidian' })).toBeVisible();
  // Publish the initial lists first, so this click changes balances only.
  await request.post('/api/settings/export-mobile');
  await writeFile(source, JSON.stringify({ schema: 1, id, author: 'owner', createdAt: new Date().toISOString(), operation: { date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 11, currency: account.currency, accountId: account.id, notes: 'Импорт через общую кнопку' } }));
  const response = page.waitForResponse((value) => value.url().endsWith('/api/settings/export-mobile') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Обновить данные Obsidian' }).click();
  const result = await (await response).json();
  expect(result.imported).toBe(1);
  expect(result.changed).toBe(false);
  expect(result.balancesChanged).toBe(true);
  await expect(page.locator('#toast-stack')).toContainText('Балансы обновлены');
  await expect(page.locator('#toast-stack')).toContainText('Импортировано: 1');
  await expect.poll(() => readFile(source).then(() => true, () => false)).toBe(false);
  const receipt = JSON.parse(await readFile(path.join(root, 'receipts', `${id}.json`), 'utf8'));
  expect(receipt.sourceDeleted).toBe(true);
  await page.locator('[data-view="operations"]').click();
  await expect(page.locator('#content')).toContainText('Импорт через общую кнопку');
  const data = await (await request.get('/api/data')).json();
  await request.delete(`/api/operations/${data.operations.find((item) => item.sourceId === id).id}`);
});

scenario('оба баланса сразу показывают USD и не меняются после сравнения или переключения вкладок', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/data')).json();
  const number = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
  const rubTotal = (accounts) => accounts.reduce((sum, account) => sum + account.calculatedBalance * (account.currency === 'RUB' ? 1 : snapshot.currentRates[account.currency]), 0);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let comparisons = 0;
  await page.route('**/api/balance/currency-comparison*', async (route) => {
    comparisons++;
    await gate;
    const response = await route.fetch();
    const payload = await response.json();
    // A late comparison must never replace the displayed balance snapshot.
    payload.currentRubTotal = 999999999;
    payload.usdTotal = 999999999;
    await route.fulfill({ response, json: payload });
  });
  await page.goto('/#balance');
  const equivalent = page.locator('.balance-hero [data-total-currency-equivalents]');
  await expect(equivalent).toHaveText(`≈ ${number(rubTotal(snapshot.accounts) / snapshot.currentRates.USD)} USD`);
  const initialTotal = await page.locator('.balance-hero [data-rub-total]').textContent();
  release();
  await expect(page.locator('.currency-comparison tfoot')).toBeVisible();
  await expect(page.locator('.balance-hero [data-rub-total]')).toHaveText(initialTotal);
  await page.locator('[data-view="savings"]').click();
  await expect(equivalent).toHaveText(`≈ ${number(rubTotal(snapshot.savingsAccounts) / snapshot.currentRates.USD)} USD`);
  await expect(page.locator('.currency-comparison tfoot')).toBeVisible();
  await page.locator('[data-view="balance"]').click();
  await expect(page.locator('.balance-hero [data-rub-total]')).toHaveText(initialTotal);
  await expect(page.locator('.currency-comparison tfoot')).toBeVisible();
  expect(comparisons).toBe(2);
});

scenario('мобильное поле даты не пересекается с отдельной кнопкой календаря', async ({ page }) => {
  const styles = await readFile(new URL('../obsidian-plugin/finance-capture/styles.css', import.meta.url), 'utf8');
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 700 });
    await page.setContent(`<style>${styles}</style><div class="finance-capture-panel"><div class="setting-item"><div class="setting-item-control finance-capture-date-control"><button class="finance-capture-calendar-button" aria-label="Выбрать дату">▦</button><input class="finance-capture-date-input" type="text" value="14.10.2026"><input class="finance-capture-native-date-picker" type="date" value="2026-10-14"></div></div></div>`);
    const button = await page.locator('button').boundingBox();
    const input = await page.locator('.finance-capture-date-input').boundingBox();
    expect(input.x - (button.x + button.width)).toBeGreaterThanOrEqual(9);
    expect(input.width).toBeGreaterThan(120);
    expect(input.x + input.width).toBeLessThanOrEqual(width);
    await page.locator('.finance-capture-date-input').fill('15.10.2026');
    await expect(page.locator('.finance-capture-date-input')).toHaveValue('15.10.2026');
  }
});

scenario('новые элементы Баланса, переводов и подтверждение очистки', async ({ page, request }) => {
  const initial = await (await request.get('/api/data')).json();
  const source = initial.accounts[0];
  const added = await (await request.put('/api/accounts', { data: { accounts: [{ name: 'UI второй счёт', currency: source.currency, rate: source.rate || 1 }] } })).json();
  const addedId = added.result.created[0];
  let releaseData;
  const dataGate = new Promise((resolve) => { releaseData = resolve; });
  await page.route('**/api/data', async (route) => { await dataGate; await route.continue(); });
  await page.goto('/#balance');
  await expect(page.locator('.nav-item.active')).toHaveAttribute('data-view', 'balance');
  await expect(page.locator('.loading-card')).toContainText('Баланс');
  await expect(page.getByRole('heading', { name: /Обзор за/ })).toHaveCount(0);
  releaseData();
  await expect(page.locator('.currency-comparison tfoot')).toBeVisible();
  const refreshedMain = page.waitForResponse((response) => response.url().includes('/api/balance/currency-comparison?refresh=true'));
  const refreshedSavings = page.waitForResponse((response) => response.url().includes('/api/balance/currency-comparison?ledger=savings'));
  let releaseRateRefresh;
  const rateRefreshGate = new Promise((resolve) => { releaseRateRefresh = resolve; });
  let startedRefreshRequests = 0;
  let markRefreshRequestsStarted;
  const refreshRequestsStarted = new Promise((resolve) => { markRefreshRequestsStarted = resolve; });
  const isForcedRefresh = (url) => url.pathname === '/api/balance/currency-comparison' && url.searchParams.get('refresh') === 'true';
  await page.route(isForcedRefresh, async (route) => {
    startedRefreshRequests += 1;
    if (startedRefreshRequests === 1) markRefreshRequestsStarted();
    await rateRefreshGate;
    await route.continue();
  });
  await page.locator('[data-action="refresh-rates"]').click();
  await refreshRequestsStarted;
  await expect(page.locator('.balance-hero [data-rub-total]')).toHaveText('Загружаем курс…');
  releaseRateRefresh();
  expect((await refreshedMain).ok()).toBeTruthy();
  expect((await refreshedSavings).ok()).toBeTruthy();
  await page.unroute(isForcedRefresh);
  await expect(page.locator('[data-action="refresh-rates"]')).toBeEnabled();
  await expect(page.locator('.balance-hero [data-total-currency-equivalents]')).toContainText('USD');
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  const name = page.locator('[data-account-row] input[name="name"]').first();
  await name.focus();
  await page.keyboard.press('F6');
  await expect(page.locator('.nav-item[data-view="balance"]')).toBeFocused();
  await page.keyboard.press('Shift+F6');
  await expect(name).toBeFocused();
  const ordered = page.waitForResponse((response) => response.url().endsWith('/api/accounts/order'));
  await page.locator(`[data-account-row="${addedId}"] .account-drag-handle`).dragTo(page.locator(`[data-account-row="${source.id}"]`), { targetPosition: { x: 20, y: 2 } });
  await ordered;
  await expect(page.locator('[data-account-row]').first()).toHaveAttribute('data-account-row', String(addedId));
  const orderedIds = await page.locator('[data-account-row]').evaluateAll((rows) => rows.map((row) => Number(row.dataset.accountRow)));
  for (const accountId of [...orderedIds].reverse()) {
    expect((await request.put('/api/operations/opening-balance', { data: { accountId, amount: 0, date: '2026-10-14' } })).ok()).toBeTruthy();
  }
  await page.route('**/api/data', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.accounts.reverse();
    await route.fulfill({ response, json: payload });
  });
  await page.reload();
  await expect(page.locator('[data-account-row]').first()).toHaveAttribute('data-account-row', String(addedId));
  const balanceOrder = await page.locator('[data-account-row]').evaluateAll((rows) => rows.map((row) => row.dataset.accountRow));
  await page.locator('.nav-item[data-view="operations"]').click();
  await page.locator('[data-operations-section="opening-balances"]').click();
  const openingBalanceOrder = await page.locator('#opening-balance-form [name="accountId"] option').evaluateAll((options) => options.map((option) => option.value));
  expect(openingBalanceOrder).toEqual(balanceOrder);
  const openingTableOrder = await page.locator('.opening-balance-table [data-edit-opening]').evaluateAll((buttons) => buttons.map((button) => button.dataset.editOpening));
  expect(openingTableOrder).toEqual(balanceOrder);
  await page.locator('.nav-item[data-view="balance"]').click();
  await page.locator('[data-action="add-operation"]').click();
  await page.getByRole('radio', { name: 'Перевод' }).check();
  await expect(page.locator('.rate-panel')).toBeHidden();
  await expect(page.locator('#operation-form [name="currency"]')).toBeHidden();
  await expect(page.locator('#amount-label')).toHaveText(`Сумма списания · ${source.currency}`);
  await expect(page.locator('#destination-amount-field span')).toHaveText(`Сумма зачисления · ${source.currency}`);
  await page.locator('#operation-form [name="amount"]').fill('123');
  await expect(page.locator('#operation-form [name="destinationAmount"]')).toHaveValue('123');
  await expect(page.locator('#operation-form [name="destinationAmount"]')).toHaveJSProperty('readOnly', true);
  await page.keyboard.press('Escape');
  await page.locator('[data-view="settings"]').click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('[data-clear-data="history"]').click();
  await expect(page.locator('[data-clear-data="all"]')).toBeVisible();
  await request.delete(`/api/accounts/${addedId}`);
});

scenario('окно новой операции прокручивается внутри границ экрана', async ({ page }) => {
  const viewportHeight = 500;
  await page.setViewportSize({ width: 390, height: viewportHeight });
  await page.goto('/');
  await page.locator('[data-action="add-operation"]').click();
  const layout = await page.locator('#operation-dialog').evaluate((dialog) => {
    const form = dialog.querySelector('#operation-form');
    form.scrollTop = form.scrollHeight;
    const bounds = dialog.getBoundingClientRect();
    const formBounds = form.getBoundingClientRect();
    const submit = dialog.querySelector('#save-operation').getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      formTop: formBounds.top,
      formBottom: formBounds.bottom,
      formLeft: formBounds.left,
      formRight: formBounds.right,
      scrollHeight: form.scrollHeight,
      clientHeight: form.clientHeight,
      scrollTop: form.scrollTop,
      submitTop: submit.top,
      submitBottom: submit.bottom,
    };
  });
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(viewportHeight);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.scrollTop).toBeGreaterThan(0);
  expect(layout.formTop).toBeGreaterThanOrEqual(layout.top);
  expect(layout.formBottom).toBeLessThanOrEqual(layout.bottom);
  expect(layout.formLeft).toBeGreaterThanOrEqual(layout.left);
  expect(layout.formRight).toBeLessThanOrEqual(layout.right - 4);
  expect(layout.submitTop).toBeGreaterThanOrEqual(layout.formTop);
  expect(layout.submitBottom).toBeLessThanOrEqual(layout.formBottom);
});

scenario('все экраны и основной финансовый сценарий', async ({ page, request }) => {
  const rateLookupRequests = [];
  page.on('request', (requestEvent) => { if (requestEvent.url().includes('/api/rates?')) rateLookupRequests.push(requestEvent.url()); });
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Обзор за/ })).toBeVisible();
  await expect(page.locator('#workbook-name')).toHaveText('e2e.xlsx');
  await expect(page.locator('.nav-item .nav-icon svg')).toHaveCount(7);
  await expect(page.locator('.nav-item[data-view="balance"] .nav-icon svg')).toBeVisible();

  await expect(page.locator('[data-action="refresh-rates"]')).toBeHidden();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  const overviewNav = page.locator('.nav-item[data-view="overview"]');
  await overviewNav.focus();
  await overviewNav.press('ArrowDown');
  await expect(page.locator('.nav-item[data-view="operations"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Операции' })).toBeVisible();
  await expect(page.locator('[data-action="refresh-rates"]')).toBeHidden();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  await page.locator('.nav-item[data-view="balance"]').click();
  await expect(page.getByRole('heading', { name: 'Счета и остатки' })).toBeVisible();
  await expect(page.locator('[data-action="refresh-rates"]')).toBeVisible();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  await page.locator('.nav-item[data-view="lists"]').click();
  await expect(page.getByRole('heading', { name: 'Справочники' })).toBeVisible();
  await expect(page.locator('[data-action="refresh-rates"]')).toBeHidden();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  await expect(page.locator('[data-reference-list="categories"] .category-name-input').first()).toHaveValue('Жильё и аренда');
  await expect(page.locator('[data-reference-list="categories"] .category-emoji-input').first()).toHaveValue('🏠');
  await page.getByRole('button', { name: 'Добавить валюту' }).click();
  const unknownCurrency = page.locator('[data-reference-list="currencies"] input').last();
  let currencyDialogMessage = '';
  page.once('dialog', async (dialog) => { currencyDialogMessage = dialog.message(); await dialog.accept(); });
  await unknownCurrency.fill('ZZZ');
  await unknownCurrency.blur();
  await expect.poll(() => currencyDialogMessage).toContain('отсутствует в справочнике ЦБ РФ');
  await unknownCurrency.locator('xpath=..').getByTitle('Удалить').click();
  await page.getByRole('button', { name: 'Добавить валюту' }).click();
  await page.locator('[data-reference-list="currencies"] input').last().fill('JPY');
  const listsResponse = page.waitForResponse((response) => response.url().endsWith('/api/lists') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить справочники' }).click();
  await listsResponse;
  await expect(page.locator('[data-reference-list="currencies"] input').last()).toHaveValue('JPY');

  const initialRateResponse = page.waitForResponse((response) => response.url().includes('/api/rates?currency=USD'));
  await page.getByRole('button', { name: /Новая операция/ }).click();
  await initialRateResponse;
  const dateInput = page.locator('input[name="date"]');
  const browserToday = await page.evaluate(() => {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    return new Date(now - offset).toISOString().slice(0, 10);
  });
  await expect(dateInput).toHaveValue(browserToday);
  const rateResponse = page.waitForResponse((response) => response.url().includes('/api/rates?currency=USD'));
  await dateInput.fill('2026-10-13');
  await rateResponse;
  await expect(page.locator('select[name="accountId"]')).toHaveValue('5');
  await expect(page.locator('select[name="currency"]')).toHaveValue('USD');
  await expect(page.locator('input[name="rate"]')).toHaveValue('91.25');
  await expect(page.locator('#rate-status')).toContainText('ЦБ РФ');
  await expect(page.locator('[name="description"]')).toHaveCount(0);
  await expect(page.locator('[name="paymentMethod"]')).toHaveCount(0);
  await page.locator('textarea[name="notes"]').fill('Playwright-покупка');
  await page.locator('input[name="amount"]').fill('20');
  await page.locator('select[name="category"]').selectOption('Продукты');
  await expect(page.locator('select[name="category"] option:checked')).toHaveText('🛒 Продукты');
  await page.locator('select[name="necessity"]').selectOption({ label: 'Обязательная' });
  const createResponse = page.waitForResponse((response) => response.url().endsWith('/api/operations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить в Excel' }).click();
  const createdOperation = await createResponse;
  const createdPayload = await createdOperation.json();
  const persistedData = await (await page.request.get('/api/data')).json();
  expect(persistedData.operations.find((item) => item.id === createdPayload.result.id).rate).toBe(91.25);
  const rateLookupsBeforeHistory = rateLookupRequests.length;
  await page.locator('.nav-item[data-view="operations"]').click();
  await expect(page.getByText('Playwright-покупка')).toBeVisible();
  expect(rateLookupRequests.length).toBe(rateLookupsBeforeHistory);
  const row = page.getByRole('row').filter({ hasText: 'Playwright-покупка' });
  await expect(row).toBeVisible();
  await expect(page.locator('.table-card thead th').last()).toHaveText('Действия');
  await row.focus();
  await row.press('Enter');
  await expect(page.getByRole('heading', { name: 'Редактирование: Расход' })).toBeVisible();
  await expect(page.locator('#operation-dialog .type-switch')).toBeHidden();
  await page.locator('textarea[name="notes"]').fill('Playwright-покупка исправлена');
  const updateResponse = page.waitForResponse((response) => response.url().match(/\/api\/operations\/\d+$/) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить в Excel' }).click();
  await updateResponse;
  await expect(page.getByText('Playwright-покупка исправлена')).toBeVisible();

  page.once('dialog', (confirmation) => confirmation.accept());
  const updatedRow = page.getByRole('row').filter({ hasText: 'Playwright-покупка исправлена' });
  const deleteResponse = page.waitForResponse((response) => response.url().match(/\/api\/operations\/\d+$/) && response.request().method() === 'DELETE');
  await updatedRow.getByTitle('Удалить').click();
  await deleteResponse;
  await expect(page.getByText('Playwright-покупка исправлена')).toHaveCount(0);

  await page.locator('.nav-item[data-view="balance"]').click();
  const firstAccountRow = page.locator('[data-account-row="5"]');
  await expect(page.locator('.accounts-table thead th')).toHaveCount(6);
  await expect(firstAccountRow.locator(':scope > td')).toHaveCount(6);
  await expect(page.locator('.accounts-table thead')).toContainText('Эквивалент в рублях');
  await expect(page.locator('.accounts-table thead')).not.toContainText('Фактический остаток');
  await expect(page.locator('.accounts-table thead')).not.toContainText('Дата начала');
  await expect(page.locator('.accounts-table thead th:last-child')).toHaveCSS('white-space', 'nowrap');
  await expect(page.locator('.accounts-table tbody tr').first().locator('.account-actions-cell')).toHaveCSS('min-width', '96px');
  const balanceLayout = await firstAccountRow.evaluate((row) => {
    const controls = [...row.querySelectorAll('input, select, textarea')];
    return {
      controlsStayInsideCells: controls.every((control) => {
        const controlBox = control.getBoundingClientRect();
        const cellBox = control.closest('td').getBoundingClientRect();
        return controlBox.left >= cellBox.left - 1 && controlBox.right <= cellBox.right + 1;
      }),
      hasHorizontalScroll: row.closest('.table-wrap').scrollWidth >= row.closest('.table-wrap').clientWidth,
      cellsAreVerticallyAligned: [...row.children].every((cell) => getComputedStyle(cell).verticalAlign === 'middle'),
    };
  });
  expect(balanceLayout.controlsStayInsideCells).toBeTruthy();
  expect(balanceLayout.hasHorizontalScroll).toBeTruthy();
  expect(balanceLayout.cellsAreVerticallyAligned).toBeTruthy();
  const actionCell = firstAccountRow.locator('.account-actions-cell');
  const deleteButton = actionCell.locator('[data-delete-account]');
  const actionCentering = await deleteButton.evaluate((button) => {
    const cell = button.closest('td');
    const cellBox = cell.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return Math.abs((cellBox.left + cellBox.right) / 2 - (buttonBox.left + buttonBox.right) / 2);
  });
  expect(actionCentering).toBeLessThanOrEqual(1);
  await expect(firstAccountRow.locator('.account-name-cell input[name="name"]')).toBeVisible();
  await firstAccountRow.focus();
  await firstAccountRow.press('Enter');
  await expect(firstAccountRow.locator('.account-name-cell input[name="name"]')).toBeFocused();
  await firstAccountRow.locator('.account-name-cell input[name="name"]').press('ArrowDown');
  await expect(firstAccountRow.locator('.account-name-cell input[name="name"]')).toBeFocused();
  await expect(firstAccountRow.locator('[data-account-calculated] small')).toHaveCount(0);
  await expect(firstAccountRow.locator('input[name="rate"]')).toHaveValue('91.25');
  await expect(firstAccountRow.locator('[data-account-calculated]')).toHaveText('0 USD');
  await expect(firstAccountRow.locator('.account-rub-cell')).toContainText('0 ₽');
  await firstAccountRow.locator('select[name="currency"]').selectOption('RUB');
  await expect(firstAccountRow.locator('input[name="rate"]')).toHaveValue('1');
  const accountsResponse = page.waitForResponse((response) => response.url().endsWith('/api/accounts') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  await accountsResponse;
  await expect(page.getByText('0 ₽').first()).toBeVisible();

  await page.getByRole('button', { name: 'Добавить счёт' }).click();
  const newAccount = page.locator('.new-account-row');
  await expect(newAccount).toHaveCount(1);
  await newAccount.locator('[name="name"]').fill('Наличные тест');
  const createAccountResponse = page.waitForResponse((response) => response.url().endsWith('/api/accounts') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить изменения' }).click();
  const createdAccountPayload = await (await createAccountResponse).json();
  const createdAccountId = createdAccountPayload.result.created[0];
  await expect(page.locator(`[data-account-row="${createdAccountId}"] [name="name"]`)).toHaveValue('Наличные тест');
  expect(createdAccountPayload.mobileLists.changed).toBeTruthy();

  page.once('dialog', (confirmation) => confirmation.accept());
  const deleteAccountResponse = page.waitForResponse((response) => response.url().endsWith(`/api/accounts/${createdAccountId}`) && response.request().method() === 'DELETE');
  await page.locator(`[data-delete-account="${createdAccountId}"]`).click();
  const deletedAccountPayload = await (await deleteAccountResponse).json();
  expect(deletedAccountPayload.mobileLists.changed).toBeTruthy();
  await expect(page.locator(`[data-account-row="${createdAccountId}"]`)).toHaveCount(0);

  await page.locator('.nav-item[data-view="settings"]').click();
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
  await expect(page.getByText('Excel и резервные копии')).toBeVisible();
  await expect(page.getByText('Мобильная синхронизация')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть папку книги' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Открыть бэкапы' })).toBeVisible();
  const restoreButtonPlacement = await page.locator('.settings-grid .settings-card:first-child .settings-actions').evaluate((actions) => {
    const box = actions.getBoundingClientRect();
    const button = actions.querySelector('[data-open-restore]').getBoundingClientRect();
    return button.left + button.width / 2 > box.left + box.width / 2;
  });
  expect(restoreButtonPlacement).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Открыть папку Syncthing' })).toBeVisible();
  const syncCardLayout = await page.locator('.settings-sync-card').evaluate((card) => {
    const cardBox = card.getBoundingClientRect();
    const actionsBox = card.querySelector('.settings-actions').getBoundingClientRect();
    const status = card.querySelector('.sync-status');
    const statusBox = status.getBoundingClientRect();
    return {
      actionsBottomGap: cardBox.bottom - actionsBox.bottom,
      rowBorder: getComputedStyle(card.querySelector('.setting-row')).borderBottomWidth,
      statusPosition: getComputedStyle(status).position,
      statusTop: statusBox.top - cardBox.top,
      statusRight: cardBox.right - statusBox.right,
      headingPadding: Number.parseFloat(getComputedStyle(card.querySelector('.card-head')).paddingRight),
    };
  });
  expect(syncCardLayout.actionsBottomGap).toBeCloseTo(23, 0);
  expect(syncCardLayout.rowBorder).toBe('0px');
  expect(syncCardLayout.statusPosition).toBe('absolute');
  expect(syncCardLayout.statusTop).toBeCloseTo(23, 0);
  expect(syncCardLayout.statusRight).toBeCloseTo(23, 0);
  expect(syncCardLayout.headingPadding).toBe(170);
  await page.getByRole('button', { name: 'Восстановить из бэкапа' }).click();
  await expect(page.locator('#restore-dialog')).toBeVisible();
  await expect(page.locator('#restore-form select[name="backup"] option')).not.toHaveCount(0);
  await page.locator('#restore-dialog [data-close-restore]').first().click();
  await expect(page.getByRole('heading', { name: 'Копия на другом носителе' })).toBeVisible();
  const archiveDownload = page.waitForEvent('download');
  await page.locator('[data-recovery-export]').click();
  expect((await archiveDownload).suggestedFilename()).toMatch(/^finance-recovery-.+\.zip$/u);
  await expect(page.locator('.recovery-status')).toContainText('Архив скачан');
  const recoveryResponse = await request.get('/api/settings/recovery/export');
  expect(recoveryResponse.ok()).toBeTruthy();
  await page.locator('[data-recovery-file]').setInputFiles({ name: 'finance-recovery-test.zip', mimeType: 'application/zip', buffer: await recoveryResponse.body() });
  await page.locator('[data-recovery-verify]').click();
  await expect(page.locator('.recovery-status')).toContainText('Архив цел');
  await expect(page.locator('.recovery-report')).toContainText('SHA-256');
  const recoveryResultOrder = await page.locator('.settings-recovery-card').evaluate((card) => {
    const children = [...card.children];
    return {
      actions: children.indexOf(card.querySelector('.settings-actions')),
      status: children.indexOf(card.querySelector('.recovery-status')),
      report: children.indexOf(card.querySelector('.recovery-report')),
      footnote: children.indexOf(card.querySelector('.recovery-footnote')),
    };
  });
  expect(recoveryResultOrder.actions).toBeLessThan(recoveryResultOrder.status);
  expect(recoveryResultOrder.status).toBeLessThan(recoveryResultOrder.report);
  expect(recoveryResultOrder.report).toBeLessThan(recoveryResultOrder.footnote);
  page.once('dialog', (confirmation) => confirmation.accept());
  await page.locator('[data-recovery-rehearse]').click();
  await expect(page.locator('.recovery-status')).toContainText('Репетиция восстановления прошла успешно');
  const exportResponse = page.waitForResponse((response) => response.url().endsWith('/api/settings/export-mobile') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Обновить данные Obsidian' }).click();
  const exportPayload = await (await exportResponse).json();
  expect(typeof exportPayload.balancesChanged).toBe('boolean');
});

scenario('операции фильтруются и сортируются по таблице', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const account = data.accounts.find((item) => item.active);
  const rate = account.currency === 'RUB' ? 1 : account.rate;
  const create = async (payload) => {
    const response = await request.post('/api/operations', { data: {
      currency: account.currency, rate, accountId: account.id, ...payload,
    } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).result.id;
  };
  const flexible = await create({
    date: '2026-10-14', type: 'Расход', category: 'Продукты', amount: 10, necessity: 'Гибкая',
    notes: 'ui-filters-sort гибкий расход', sourceId: 'ui-filter-flex-expense',
  });
  const required = await create({
    date: '2026-10-13', type: 'Расход', category: 'Продукты', amount: 20, necessity: 'Обязательная',
    notes: 'ui-filters-sort обязательный расход', sourceId: 'ui-filter-required-expense',
  });
  const income = await create({
    date: '2026-10-14', type: 'Доход', category: 'Работа / зарплата', amount: 15, necessity: '',
    notes: 'ui-filters-sort доход', sourceId: 'ui-filter-income',
  });
  const operationIds = new Set([flexible, required, income]);
  const expectedDateOrder = (await (await request.get('/api/data')).json()).operations
    .filter((item) => operationIds.has(item.id))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '')
      || Date.parse(b.recordedAt) - Date.parse(a.recordedAt)
      || b.id - a.id)
    .map((item) => item.id);

  try {
    await page.goto('/#operations');
    const browserMonth = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    await expect(page.locator('#operation-month')).toHaveValue(browserMonth);
    await expect(page.getByRole('columnheader', { name: 'Тип' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Необходимость' })).toBeVisible();
    const row = page.locator(`[data-operation-row="${flexible}"]`);
    await expect(row.locator('td').nth(4)).toHaveText('Расход');
    await expect(row.locator('td').nth(4).locator('.tag')).toHaveCSS('color', 'rgb(163, 59, 52)');
    await expect(row.locator('td').nth(4).locator('.tag')).toHaveCSS('background-color', 'rgb(248, 226, 223)');
    await expect(row.locator('td').nth(5)).toHaveText('Гибкая');
    const incomeRow = page.locator(`[data-operation-row="${income}"]`);
    await expect(incomeRow.locator('td').nth(4).locator('.tag')).toHaveCSS('color', 'rgb(23, 79, 145)');
    await expect(incomeRow.locator('td').nth(4).locator('.tag')).toHaveCSS('background-color', 'rgb(220, 236, 255)');

    await page.locator('#operation-type').selectOption('Расход');
    await page.locator('#operation-category').selectOption('Продукты');
    await page.locator('#operation-account').selectOption(String(account.id));
    await page.locator('#operation-necessity').selectOption('Гибкая');
    await page.locator('#operation-date-from').fill('2026-10-14');
    await page.locator('#operation-date-to').fill('2026-10-14');
    await expect(page.locator('[data-operation-row]')).toHaveCount(1);
    await expect(page.locator(`[data-operation-row="${flexible}"]`)).toBeVisible();

    await page.locator('#clear-operation-filters').click();
    await page.locator('#operation-search').fill('ui-filters-sort');
    await expect(page.locator('[data-operation-row]')).toHaveCount(3);
    const dateOrder = await page.locator('[data-operation-row]').evaluateAll((rows) => rows.map((item) => Number(item.dataset.operationRow)));
    expect(dateOrder).toEqual(expectedDateOrder);
    await page.locator('[data-sort-key="amount"]').click();
    const ascending = await page.locator('[data-operation-row]').evaluateAll((rows) => rows.map((item) => Number(item.dataset.operationRow)));
    expect(ascending).toEqual([flexible, income, required]);
    await page.locator('[data-sort-key="amount"]').click();
    const descending = await page.locator('[data-operation-row]').evaluateAll((rows) => rows.map((item) => Number(item.dataset.operationRow)));
    expect(descending).toEqual([required, income, flexible]);
  } finally {
    for (const id of [flexible, required, income]) await request.delete(`/api/operations/${id}`);
  }
});

scenario('выбранный экран сохраняется при перезагрузке и работает в истории', async ({ page }) => {
  await page.goto('/#balance');
  await expect(page.getByRole('heading', { name: 'Счета и остатки' })).toBeVisible();
  const badge = page.locator('.balance-account-count');
  await expect(badge).toHaveText('1 активный счёт');
  const contrast = await badge.evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
  expect(contrast.color).not.toBe(contrast.background);
  await page.reload();
  await expect(page).toHaveURL(/#balance$/);
  await expect(page.getByRole('heading', { name: 'Счета и остатки' })).toBeVisible();
  await page.locator('.nav-item[data-view="settings"]').click();
  await expect(page).toHaveURL(/#settings$/);
  await page.goBack();
  await expect(page).toHaveURL(/#balance$/);
  await expect(page.getByRole('heading', { name: 'Счета и остатки' })).toBeVisible();
});

scenario('обзор корректно объясняет расходы без доходов', async ({ page }) => {
  const expenses = [
    ['Жильё', 700.5, 'Обязательная'],
    ['Продукты', 600, 'Обязательная'],
    ['Транспорт', 500, 'Обязательная'],
    ['Здоровье', 400, 'Обязательная'],
    ['Развлечения', 300, 'Гибкая'],
    ['Подписки', 200, 'Гибкая'],
    ['Подарки', 100, 'Гибкая'],
  ];
  const operations = expenses.map(([category, rubAmount, necessity], index) => ({
    id: index + 5, date: `2026-01-${String(20 - index).padStart(2, '0')}`, type: 'Расход', category,
    amount: rubAmount, currency: 'RUB', rate: 1, rubAmount,
    necessity, notes: category, sourceId: '', recordedAt: index === 0 ? '2026-01-20T12:30:00.000Z' : undefined,
  }));
  operations.push({
    id: 20, date: '2026-01-21', type: 'Перевод', category: '', amount: 999,
    currency: 'RUB', rate: 1, rubAmount: 999, necessity: '', notes: 'Между счетами', sourceId: '', accountId: 5, destinationAccountId: 6, destinationAmount: 999,
  });
  await page.route('**/api/data', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ workbook: 'overview-test.xlsx', summaryMonth: '2026-01', operations, balances: [{ id: 5, rubAmount: 3500 }], lists: {} }),
  }));
  await page.goto('/');

  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  await page.locator('.nav-item[data-view="settings"]').click();
  await expect(page.locator('[data-action="refresh-rates"]')).toBeHidden();
  await expect(page.locator('[data-action="add-operation"]')).toBeHidden();
  await page.locator('.nav-item[data-view="overview"]').click();

  const result = page.locator('[data-overview-metric="result"]');
  await expect(result).toContainText('Результат месяца');
  await expect(result).toContainText(/-2\s*800,5\s*₽/);
  await expect(result).toContainText('Нет доходов за период');
  await expect(result).toHaveClass(/negative/);
  await expect(page.locator('[data-overview-metric="balance"]')).toContainText('Расчётно по всем активным счетам');

  await expect(page.getByLabel('Расходы по необходимости')).toContainText('2 200,5 ₽ · 79%');
  await expect(page.getByLabel('Расходы по необходимости')).toContainText('600 ₽ · 21%');
  await expect(page.locator('.category-row')).toHaveCount(7);
  await expect(page.locator('.category-row').filter({ hasText: 'Жильё' })).toContainText('25%');
  await expect(page.locator('.category-row').filter({ hasText: 'Остальные' })).toHaveCount(0);

  await expect(page.locator('.chart-label').first()).toHaveText('авг 25');
  await expect(page.locator('.chart-label').last()).toHaveText('янв 26');
  await expect(page.locator('.chart-group').first().locator('.bar').first()).toHaveAttribute('style', 'height:0px');
  await expect(page.locator('.overview-main .metrics')).toHaveCSS('grid-template-columns', /.+ .+/);
  await expect(page.locator('.category-list')).toHaveCSS('overflow-y', 'auto');
  const overviewMainBox = await page.locator('.overview-main').evaluate((element) => element.getBoundingClientRect());
  const spendingHeight = await page.locator('.spending-card').evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(overviewMainBox.height - spendingHeight)).toBeLessThanOrEqual(1);
  await expect(page.locator('.recent-card thead th')).toHaveCount(7);
  await expect(page.locator('.recent-card .table-wrap table')).toHaveCSS('table-layout', 'auto');
  await expect(page.locator('.recent-card .card-head h2')).toHaveCSS('font-size', '17px');
  await expect(page.locator('.recent-card thead th:nth-child(7)')).toHaveCSS('text-align', 'right');
  await expect(page.locator('.recent-card tbody td:nth-child(7)').first()).toHaveCSS('text-align', 'right');
  const recentDate = page.locator('.recent-card tbody tr').first().locator('.operation-date');
  const recentDateOrder = await recentDate.evaluate((cell) => ({
    timeIsFirst: cell.firstElementChild === cell.querySelector('time.operation-time'),
    lines: cell.innerText.split('\n').map((line) => line.trim()).filter(Boolean),
  }));
  expect(recentDateOrder.timeIsFirst).toBeTruthy();
  expect(recentDateOrder.lines[0]).toMatch(/^\d{2}:\d{2}$/u);
  expect(recentDateOrder.lines[1]).toContain('2026');
});

scenario('инвестиции пополняют накопления, а вкладка накоплений оставляет только вывод', async ({ page, request }) => {
  const main = (await (await request.get('/api/data')).json()).accounts[0];
  const accountName = `UI вклад ${Date.now()}`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#savings');
  await expect(page.getByRole('heading', { name: 'Накопления' })).toBeVisible();
  await expect(page.locator('.savings-hero [data-rub-total]')).not.toHaveText('Загружаем курс…');
  await expect(page.locator('.savings-rub-total [data-rub-total]')).not.toHaveText('Загружаем курс…');
  await expect(page.locator('[data-action="refresh-rates"]')).toBeVisible();
  await expect(page.locator('[data-action="add-operation"]')).toBeVisible();
  await expect(page.locator('.savings-hero [data-total-currency-equivalents]')).toContainText('USD');
  const createControlHeights = await page.locator('#savings-create-form').evaluate((form) => [...form.querySelectorAll('input, select, button[type="submit"]')].map((control) => control.getBoundingClientRect().height));
  expect(new Set(createControlHeights)).toEqual(new Set([44]));
  await expect(page.locator('#savings-create-form [name="name"]')).toHaveAttribute('placeholder', 'Например, Резервный вклад');
  await expect.poll(() => page.locator('#savings-create-form [name="name"]').evaluate((input) => getComputedStyle(input, '::placeholder').fontSize)).toBe('10px');
  await expect(page.locator('#savings-create-form [name="name"]')).toHaveCSS('line-height', '40px');
  await page.locator('#savings-create-form [name="name"]').fill(accountName);
  await page.locator('#savings-create-form [name="type"]').selectOption('Вклад');
  await page.locator('#savings-create-form [name="currency"]').selectOption('RUB');
  await page.locator('#savings-create-form [name="initialCapital"]').fill('100');
  const create = page.waitForResponse((response) => response.url().endsWith('/api/savings/accounts') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Добавить счёт' }).click();
  const createPayload = await (await create).json();
  const card = page.locator('.savings-account-card').filter({ hasText: accountName });
  await expect(card.locator('.savings-balance')).toContainText('100');
  await expect.poll(() => card.locator('[name="amount"]').evaluate((input) => getComputedStyle(input, '::placeholder').fontSize)).toBe('10px');
  await expect(card.getByRole('button', { name: 'Изменить капитал' })).toBeVisible();
  const desktopControls = await Promise.all([
    card.locator('[name="amount"]'), card.locator('[name="date"]'),
    card.getByRole('button', { name: 'Изменить капитал' }), card.locator('[data-savings-history]'),
  ].map((control) => control.boundingBox()));
  for (const [controlBox, buttonBox] of [[desktopControls[0], desktopControls[2]], [desktopControls[1], desktopControls[3]]]) {
    expect(Math.abs(controlBox.x - buttonBox.x)).toBeLessThan(1);
    expect(Math.abs(controlBox.width - buttonBox.width)).toBeLessThan(1);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileControls = await Promise.all([
    card.locator('[name="amount"]'), card.getByRole('button', { name: 'Изменить капитал' }), card.locator('[data-savings-history]'),
  ].map((control) => control.boundingBox()));
  for (const buttonBox of mobileControls.slice(1)) {
    expect(Math.abs(mobileControls[0].x - buttonBox.x)).toBeLessThan(1);
    expect(Math.abs(mobileControls[0].width - buttonBox.width)).toBeLessThan(1);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await card.locator('[name="amount"]').fill('12');
  const increase = page.waitForResponse((response) => response.url().includes('/increase') && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Изменить капитал' }).click();
  await increase;
  await expect(page.locator('.savings-account-card').filter({ hasText: accountName }).locator('.savings-balance')).toContainText('112');
  await expect(card.locator('[name="amount"]')).toHaveAttribute('placeholder', 'Можно ввести отрицательную');
  await expect(card.locator('[name="amount"]')).toHaveCSS('line-height', '40px');
  const withdrawalForm = page.locator('#savings-transfer-form');
  await expect(withdrawalForm.locator('[name="direction"]')).toHaveValue('from-savings');
  await expect(withdrawalForm.locator('select[name="direction"]')).toHaveCount(0);
  const [savingsAccountBox, savingAmountBox, mainAccountBox, mainAmountBox, dateBox, submitBox] = await Promise.all([
    '.savings-transfer-savings-account', '.savings-transfer-saving-amount', '.savings-transfer-main-account',
    '.savings-transfer-main-amount', '.savings-transfer-date', '.savings-transfer-submit',
  ].map((selector) => withdrawalForm.locator(selector).boundingBox()));
  expect(Math.abs(savingsAccountBox.x - savingAmountBox.x)).toBeLessThan(2);
  expect(savingAmountBox.y).toBeGreaterThan(savingsAccountBox.y);
  expect(Math.abs(mainAccountBox.x - mainAmountBox.x)).toBeLessThan(2);
  expect(mainAmountBox.y).toBeGreaterThan(mainAccountBox.y);
  expect(Math.abs(dateBox.x - submitBox.x)).toBeLessThan(2);
  expect(dateBox.y).toBeLessThan(submitBox.y);
  await page.locator('[data-action="add-operation"]').click();
  const investmentDialog = page.locator('#operation-dialog');
  await investmentDialog.getByRole('radio', { name: 'Инвестиция' }).check();
  await expect(investmentDialog.locator('.rate-panel')).toBeHidden();
  await investmentDialog.locator('[name="savingsAccountId"]').selectOption(String(createPayload.result.id));
  await expect(investmentDialog.locator('#investment-category-label')).toHaveValue('Вклад');
  const investmentSourceName = await investmentDialog.locator('[name="accountId"] option:checked').textContent();
  const investmentSourceCurrency = investmentSourceName.split(' · ').at(-1);
  await expect(investmentDialog.locator('#amount-label')).toHaveText(`Сумма списания · ${investmentSourceCurrency}`);
  await expect(investmentDialog.locator('#destination-amount-field span')).toHaveText('Сумма зачисления · RUB');
  await investmentDialog.locator('[name="amount"]').fill('1');
  await expect(investmentDialog.locator('[name="destinationAmount"]')).toHaveValue('');
  await expect(investmentDialog.locator('[name="destinationAmount"]')).toHaveJSProperty('readOnly', false);
  await investmentDialog.locator('[name="destinationAmount"]').fill('30');
  const investmentRequest = page.waitForResponse((response) => response.url().endsWith('/api/operations') && response.request().method() === 'POST');
  await investmentDialog.locator('#save-operation').click();
  const investmentResponse = await investmentRequest;
  expect(investmentResponse.status()).toBe(201);
  const investmentPayload = await investmentResponse.json();
  const investmentOperation = investmentPayload.data.operations.find((item) => item.id === investmentPayload.result.id);
  expect(investmentOperation.type).toBe('Инвестиция');
  expect(investmentOperation.exchange).toMatchObject({ sourceCurrency: 'USD', destinationCurrency: 'RUB', rubDifference: -61.25 });
  expect(investmentOperation.exchange.referenceRates.map((rate) => rate.rate)).toEqual([91.25, 1]);
  expect(investmentPayload.data.savingsAccounts.find((item) => item.name === accountName).calculatedBalance).toBe(142);
  await expect(page.locator('.savings-account-card').filter({ hasText: accountName }).locator('.savings-balance')).toContainText('142');
  await expect(page.locator('.savings-comparison tfoot')).toContainText('Итого по всем счетам');
  await withdrawalForm.locator('[name="savingAccountId"]').selectOption(String(createPayload.result.id));
  await withdrawalForm.locator('[name="savingAmount"]').fill('5');
  await expect(withdrawalForm.locator('[name="mainAmount"]')).toHaveValue('');
  await withdrawalForm.locator('[name="mainAmount"]').fill('0.05');
  const withdrawalRequest = page.waitForResponse((response) => response.url().endsWith('/api/savings/transfers') && response.request().method() === 'POST');
  await withdrawalForm.locator('button[type="submit"]').click();
  const withdrawalResponse = await withdrawalRequest;
  expect(withdrawalResponse.status()).toBe(201);
  const withdrawalPayload = await withdrawalResponse.json();
  const withdrawalOperation = withdrawalPayload.data.operations.find((item) => item.id === withdrawalPayload.result.id);
  expect(withdrawalOperation.exchange).toMatchObject({ sourceCurrency: 'RUB', destinationCurrency: 'USD', rubDifference: -0.4375 });
  expect(withdrawalPayload.data.savingsAccounts.find((item) => item.name === accountName).calculatedBalance).toBe(137);
  await expect(page.locator('.savings-account-card').filter({ hasText: accountName }).locator('.savings-balance')).toContainText('137');
  await page.locator('.nav-item[data-view="overview"]').click();
  await expect(page.locator('[data-overview-metric="expense"] .metric-value')).toContainText('91');
  await expect(page.locator('.necessity-legend')).toContainText('Инвестиции');
  await expect(page.locator('.category-list')).toContainText('Вклад');
  await expect(page.locator('.category-list')).not.toContainText('Накопление');
  await expect(page.locator('.legend')).toContainText('Инвестиции в расходах');
  await page.locator('.nav-item[data-view="operations"]').click();
  const investmentRow = page.locator(`[data-operation-row="${investmentPayload.result.id}"]`);
  await expect(investmentRow.locator('.operation-note')).toContainText('1 USD → 30 RUB');
  await expect(investmentRow.locator('.operation-note small')).toHaveCount(2);
  await expect(investmentRow.locator('.exchange-loss')).toContainText('Хуже ЦБ: −61,25 ₽');
  const withdrawalRow = page.locator(`[data-operation-row="${withdrawalPayload.result.id}"]`);
  await expect(withdrawalRow.locator('.operation-note')).toContainText('5 RUB → 0,05 USD');
  await expect(withdrawalRow.locator('.exchange-loss')).toContainText('Хуже ЦБ: −0,44 ₽');
  const deleteWithdrawal = page.locator(`[data-delete="${withdrawalPayload.result.id}"]`);
  await expect(deleteWithdrawal).toHaveAttribute('title', 'Удалить перевод и отменить движение средств');
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('Движение в накопительном счёте и зачисление на обычный счёт будут отменены');
    await confirmation.accept();
  });
  const deletedWithdrawalRequest = page.waitForResponse((response) => response.url().endsWith(`/api/operations/${withdrawalPayload.result.id}`) && response.request().method() === 'DELETE');
  await deleteWithdrawal.click();
  const deletedWithdrawal = await (await deletedWithdrawalRequest).json();
  expect(deletedWithdrawal.data.savingsAccounts.find((item) => item.name === accountName).calculatedBalance).toBe(142);
  expect(deletedWithdrawal.data.accounts.find((item) => item.id === main.id).calculatedBalance).toBe(main.calculatedBalance - 1);
  await expect(page.locator(`[data-operation-row="${withdrawalPayload.result.id}"]`)).toHaveCount(0);
});

scenario('обычный перевод между валютами показывает курсы ЦБ и результат, одинаковые валюты остаются без доп. блока', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const source = data.accounts.find((item) => item.currency === 'USD') || data.accounts[0];
  const createdAccounts = await request.put('/api/accounts', { data: { accounts: [
    { name: 'FX transfer target RUB', currency: 'RUB', rate: 1 },
    { name: 'Same-currency target', currency: source.currency, rate: source.rate || 1 },
  ] } });
  expect(createdAccounts.ok()).toBeTruthy();
  const [rubTarget, sameCurrencyTarget] = (await createdAccounts.json()).result.created;
  const fxResponse = await request.post('/api/operations', { data: {
    date: data.asOfDate, type: 'Перевод', amount: 1, currency: source.currency,
    accountId: source.id, destinationAccountId: rubTarget, destinationAmount: 100,
  } });
  expect(fxResponse.status()).toBe(201);
  const fxPayload = await fxResponse.json();
  const fxOperation = fxPayload.data.operations.find((item) => item.id === fxPayload.result.id);
  expect(fxOperation.exchange).toMatchObject({ sourceCurrency: 'USD', destinationCurrency: 'RUB', rubDifference: 8.75 });
  const sameCurrencyResponse = await request.post('/api/operations', { data: {
    date: data.asOfDate, type: 'Перевод', amount: 5, currency: source.currency,
    accountId: source.id, destinationAccountId: sameCurrencyTarget, destinationAmount: 5,
  } });
  expect(sameCurrencyResponse.status()).toBe(201);
  const sameCurrencyPayload = await sameCurrencyResponse.json();

  await page.goto('/#operations');
  const fxRow = page.locator(`[data-operation-row="${fxPayload.result.id}"]`);
  await expect(fxRow.locator('.operation-note')).toContainText('1 USD → 100 RUB');
  await expect(fxRow.locator('.operation-note small')).toHaveCount(2);
  await expect(fxRow.locator('.exchange-gain')).toContainText('Лучше ЦБ: +8,75 ₽');
  const sameCurrencyRow = page.locator(`[data-operation-row="${sameCurrencyPayload.result.id}"]`);
  await expect(sameCurrencyRow.locator('.operation-note')).not.toContainText('ЦБ РФ');
  await expect(sameCurrencyRow.locator('.exchange-gain, .exchange-loss')).toHaveCount(0);
});

scenario('справочник показывает фиксированные категории инвестиций', async ({ page }) => {
  await page.goto('/#lists');
  const categories = page.locator('.system-reference').filter({ has: page.getByRole('heading', { name: 'Категории инвестиций' }) });
  await expect(categories).toContainText('Вклад');
  await expect(categories).toContainText('Отложенные');
  await expect(categories).toContainText('Защищено');
  await expect(categories.locator('input, select, button')).toHaveCount(0);
});

scenario('начальный баланс обычного счёта меняется из операций и не становится доходом', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const account = data.accounts[0];
  await page.goto('/#operations');
  await page.getByRole('tab', { name: 'Начальные балансы' }).click();
  const form = page.locator('#opening-balance-form');
  await expect(form).toBeVisible();
  await expect(form.locator('[name="date"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await form.locator('[name="accountId"]').selectOption(String(account.id));
  await form.locator('[name="amount"]').fill('321');
  await form.locator('[name="date"]').fill('2026-10-03');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/operations/opening-balance') && response.request().method() === 'PUT');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.locator('.table-card')).toContainText('Начальный баланс');
  await expect(page.locator('.opening-balance-table')).toContainText('Эквивалент в рублях');
  await expect(page.locator('.opening-balance-table')).not.toContainText('Категория');
  await expect(page.locator('.opening-balance-table')).not.toContainText('Заметка');
  await expect(page.locator('.opening-balance-table')).toContainText('03 окт. 2026');
  const after = await (await request.get('/api/data')).json();
  expect(after.operations.length).toBe(data.operations.length);
  expect(after.accounts.find((item) => item.id === account.id).calculatedBalance).toBe(account.calculatedBalance + 321);
});


scenario('identity: подтверждённый сброс сохраняет капитал, полная очистка удаляет оба учёта', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const main = data.accounts[0];
  expect((await request.put('/api/operations/opening-balance', { data: { accountId: main.id, amount: 100 } })).ok()).toBeTruthy();
  const saving = await (await request.post('/api/savings/accounts', { data: { name: 'Reset UI', type: 'Вклад', currency: 'RUB', initialCapital: 200 } })).json();
  await request.post(`/api/savings/accounts/${saving.result.id}/increase`, { data: { amount: 5, date: '2026-10-14' } });
  await page.goto('/#settings');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('начальный капитал сохранятся');
    await dialog.accept('УДАЛИТЬ ИСТОРИЮ');
  });
  const history = page.waitForResponse((response) => response.url().endsWith('/api/settings/clear-data'));
  await page.locator('[data-clear-data="history"]').click();
  const kept = await (await history).json();
  expect(kept.data.savingsAccounts[0].calculatedBalance).toBe(200);
  expect(kept.data.accounts[0].calculatedBalance).toBe(100);
  await expect(page.locator('#toast-stack')).toContainText('Данные очищены');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('оба вида счетов');
    await dialog.accept('ПОЛНАЯ ОЧИСТКА');
  });
  const all = page.waitForResponse((response) => response.url().endsWith('/api/settings/clear-data'));
  await page.locator('[data-clear-data="all"]').click();
  const cleared = await (await all).json();
  expect(cleared.data.accounts).toEqual([]);
  expect(cleared.data.savingsAccounts).toEqual([]);
  expect(cleared.data.openingBalances).toEqual([]);
});

scenario('повторяемая ошибка синхронизации отображается без потери управления', async ({ page }) => {
  await page.route('**/api/settings/export-mobile', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Хранилище недоступно.', code: 'STORAGE_UNAVAILABLE', retryable: true }) }));
  await page.goto('/#settings');
  const button = page.getByRole('button', { name: 'Обновить данные Obsidian' });
  await button.click();
  await expect(page.locator('#toast-stack')).toContainText('Можно повторить после устранения причины');
  await expect(button).toBeEnabled();
});

scenario('lifecycle: returning to desktop loads background operations', async ({ page, request }) => {
  await page.goto('/#operations');
  await expect(page.locator('#workbook-name')).toHaveAttribute('data-revision', /[a-f0-9]{64}/);
  const data = await (await request.get('/api/data')).json();
  const response = await request.post('/api/operations', { data: { date: data.asOfDate, type: 'Доход', category: 'Работа / зарплата', amount: 7, currency: data.accounts[0].currency, rate: data.accounts[0].rate, accountId: data.accounts[0].id, notes: 'background-arrival' } });
  expect(response.status()).toBe(201);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#content')).toContainText('background-arrival');
});

scenario('lifecycle: failed day refresh remains stale and retries from another screen', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  await page.goto('/#settings');
  await expect(page.locator('#workbook-name')).toHaveAttribute('data-as-of-date', data.asOfDate);
  const nextDay = '2026-12-01';
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: { revision: data.revision, asOfDate: nextDay } }));
  let fail = true;
  await page.route('**/api/data', (route) => route.fulfill(fail ? { status: 503, json: { error: 'Temporary', retryable: true } } : { json: { ...data, asOfDate: nextDay } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#toast-stack')).toContainText('Temporary');
  await expect(page.locator('#workbook-name')).toHaveAttribute('data-as-of-date', data.asOfDate);
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#workbook-name')).toHaveAttribute('data-as-of-date', nextDay);
});

scenario('lifecycle: delayed background response preserves a draft started during loading', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  await page.goto('/#savings');
  const input = page.locator('#savings-create-form [name="name"]');
  await expect(input).toBeVisible();
  await page.route('**/api/snapshot', (route) => route.fulfill({ json: { revision: 'different', asOfDate: data.asOfDate } }));
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  await page.route('**/api/data', async (route) => { entered(); await gate; await route.fulfill({ json: data }); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started;
  await input.fill('Несохранённый черновик');
  const response = page.waitForResponse('**/api/data');
  release(); await response;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(input).toHaveValue('Несохранённый черновик');
});

scenario('locales: desktop and first-run screens switch RU/EN and retain the selected language', async ({ page }) => {
  await page.route('**/api/updates/check', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled: true, currentVersion: '1.3.0', channel: 'stable', update: {
      version: '1.3.1', channel: 'stable', publishedAt: '2026-10-30T10:00:00Z', notes: '',
      url: 'https://example.invalid/release', installerName: 'Finance-Setup-1.3.1-x64.exe',
    } }),
  }));
  await page.goto('/#settings');
  await page.evaluate(() => localStorage.setItem('finance:locale', 'en'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#content h1')).toHaveText('Settings');
  await expect(page.locator('#locale-select')).toHaveValue('en');

  await page.locator('#locale-select').selectOption('ru');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.locator('#content h1')).toHaveText('Настройки');
  await page.reload();
  await expect(page.locator('#content h1')).toHaveText('Настройки');
  await expect(page.locator('#locale-select')).toHaveValue('ru');

  await page.locator('#locale-select').selectOption('en');
  await expect(page.locator('#content h1')).toHaveText('Settings');
  for (const [view, heading] of [
    ['overview', /Overview for/],
    ['operations', 'Operations'],
    ['balance', 'Accounts and balances'],
    ['savings', 'Savings'],
    ['lists', 'Reference lists'],
    ['phone', 'Connect phone'],
    ['settings', 'Settings'],
  ]) {
    await page.goto(`/#${view}`);
    await expect(page.locator('#content h1')).toHaveText(heading);
    if (view === 'balance') await expect(page.locator('.currency-comparison p')).toBeVisible();
    const untranslated = await untranslatedUiText(page);
    expect(untranslated, `Untranslated Russian UI on #${view}`).toEqual([]);
  }
  await page.locator('#locale-select').selectOption('ru');
  for (const view of ['overview', 'operations', 'balance', 'savings', 'lists', 'phone', 'settings']) {
    await page.goto(`/#${view}`);
    const untranslated = await untranslatedUiText(page, 'ru');
    expect(untranslated, `Untranslated English UI on #${view}`).toEqual([]);
  }
  await page.locator('#locale-select').selectOption('en');
  await page.locator('[data-check-update]').click();
  const updateNotice = page.locator('#topbar-update-notice');
  await expect(updateNotice).toBeVisible();
  await expect(updateNotice).toContainText('Finance update available');
  await expect(updateNotice).toHaveAttribute('aria-label', 'Finance update available: 1.3.1. Open update settings.');
  expect(await untranslatedUiText(page), 'Untranslated Russian UI with update notice').toEqual([]);
  await page.locator('#locale-select').selectOption('ru');
  await expect(updateNotice).toHaveAttribute('aria-label', 'Доступно обновление Finance 1.3.1. Открыть настройки обновления.');
  await page.locator('#locale-select').selectOption('en');
  await expect(updateNotice).toHaveAttribute('aria-label', 'Finance update available: 1.3.1. Open update settings.');
  await page.route('**/api/settings/export-mobile', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Русский текст должен игнорироваться', code: 'STORAGE_UNAVAILABLE', retryable: true }),
  }));
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Update Obsidian data' }).click();
  await expect(page.locator('#toast-stack')).toContainText('Finance could not save the workbook.');
  await expect(page.locator('#toast-stack')).toContainText('You can try again after fixing the issue.');
  expect(await untranslatedUiText(page), 'Untranslated Russian UI in error toast').toEqual([]);
  await page.goto('/#operations');
  await expect(page.locator('#operation-search')).toHaveAttribute('placeholder', 'Note, category, or account');
  await expect(page.locator('#operation-category option[data-locale-preserve]').filter({ hasText: 'Продукты' })).toHaveCount(1);
  const typeOptions = await page.locator('#operation-type option').evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent.trim() })));
  expect(typeOptions).toEqual([
    { value: 'Все', label: 'All types' },
    { value: 'Расход', label: 'Expense' },
    { value: 'Доход', label: 'Income' },
    { value: 'Перевод', label: 'Transfer' },
    { value: 'Инвестиция', label: 'Investment' },
  ]);
  await expect(page.locator('#operation-category option').first()).toHaveText('All categories');
  await expect(page.locator('#operation-category optgroup').first()).toHaveAttribute('label', 'Has operations in the selected period');
  await expect(page.locator('#operation-account option').first()).toHaveText('All accounts');
  await expect(page.locator('#operation-necessity option').first()).toHaveText('Any');
  await page.goto('/#overview');
  const directionOptions = await page.locator('#overview-direction option').allTextContents();
  expect(directionOptions.map((value) => value.trim())).toEqual(['Expenses', 'Income']);
  await expect(page.locator('.category-list')).toHaveAttribute('aria-label', 'Category list');
  await page.locator('.nav-item[data-view="savings"]').click();
  await expect(page.locator('.savings-metrics')).toContainText('Set aside');
  await expect(page.locator('.savings-metrics')).toContainText('Deposits');
  await page.goto('/#operations');
  await page.getByRole('button', { name: 'New operation' }).click();
  await expect(page.locator('#operation-dialog')).toBeVisible();
  await expect(page.locator('#operation-dialog [role="radiogroup"]')).toContainText('Expense');
  const invalidAmount = page.locator('#operation-form [name="amount"]');
  await invalidAmount.evaluate((input) => { input.value = 'abc'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(() => invalidAmount.evaluate((input) => input.validationMessage)).toBe('Enter an amount using digits, commas, and a decimal point.');
  expect(await untranslatedUiText(page), 'Untranslated Russian UI in operation form').toEqual([]);
  await page.evaluate(() => localStorage.removeItem('finance:locale'));
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { get: () => 'en-US' }));
  await page.goto('/setup.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("Let's set up your finance journal");
  await expect(page.getByRole('button', { name: 'Create a new workbook' })).toBeVisible();
  expect(await untranslatedUiText(page), 'Untranslated Russian UI on /setup.html').toEqual([]);
});

scenario('recordedAt: operation list shows the server recording time for new rows', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const created = await request.post('/api/operations', { data: {
    date: data.asOfDate,
    type: 'Расход',
    category: 'Продукты',
    amount: 3,
    currency: data.accounts[0].currency,
    rate: data.accounts[0].rate,
    accountId: data.accounts[0].id,
    notes: 'recordedAt-ui-check',
  } });
  expect(created.status()).toBe(201);
  const operationId = (await created.json()).result.id;
  await page.goto('/#operations');
  await expect(page.locator('#workbook-name')).toHaveAttribute('data-revision', /[a-f0-9]{64}/);
  const row = page.locator(`[data-operation-row="${operationId}"]`);
  await expect(row.locator('time.operation-time')).toHaveAttribute('datetime', /2026-10-16T/);
  await expect(row.locator('time.operation-time')).toHaveText(/\d{2}:\d{2}/);
});

scenario('lifecycle: browser registers its tab and releases it on pagehide', async ({ page }) => {
  const events = [];
  await page.route('**/api/system/presence', async (route) => {
    events.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.goto('/#home');
  await expect.poll(() => events.filter(({ active }) => active === true).length).toBeGreaterThan(0);
  const [registration] = events.filter(({ active }) => active === true);
  expect(registration.clientId).toMatch(/^[0-9a-f-]{36}$/i);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => events.filter(({ active }) => active === false).length).toBe(1);
  expect(events.find(({ active }) => active === false).clientId).toBe(registration.clientId);
});

scenario('lifecycle: closing one real browser tab keeps Finance alive until the last tab closes', async ({ page, baseURL }) => {
  test.setTimeout(45_000);
  const origin = new URL(baseURL).origin;
  const health = async () => fetch(`${origin}/api/settings`, { signal: AbortSignal.timeout(500) })
    .then((response) => response.status)
    .catch(() => 0);
  const waitForRegistration = (tab) => tab.waitForRequest((request) => {
    if (!request.url().endsWith('/api/system/presence')) return false;
    try { return request.postDataJSON().active === true; }
    catch { return false; }
  });

  const firstRegistered = waitForRegistration(page);
  await page.goto(`${origin}/#home`);
  await firstRegistered;
  await expect.poll(health).toBe(200);

  const second = await page.context().newPage();
  const secondRegistered = waitForRegistration(second);
  await second.goto(`${origin}/#home`);
  await secondRegistered;

  await page.close();
  await expect.poll(health).toBe(200);

  await second.close();
  await expect.poll(health, { timeout: 25_000 }).toBe(0);
});

scenario('lifecycle: closing the whole browser stops Finance by pagehide or the presence lease', async ({ browser, financeServer }) => {
  test.setTimeout(180_000);
  const isolatedBrowser = await browser.browserType().launch();
  const page = await isolatedBrowser.newPage();
  const { baseURL, presenceEvents } = financeServer;
  const origin = new URL(baseURL).origin;
  const health = async () => fetch(`${origin}/api/settings`, { signal: AbortSignal.timeout(500) })
    .then((response) => response.status)
    .catch(() => 0);
  await page.goto(`${origin}/#home`);
  await expect.poll(() => presenceEvents.some(({ body }) => body?.active === true)).toBe(true);
  const closedAt = performance.now();

  await isolatedBrowser.close();
  await expect.poll(health, { timeout: 165_000, intervals: [500, 1000, 2000] }).toBe(0);

  const elapsedMs = performance.now() - closedAt;
  const release = presenceEvents.find(({ body }) => body?.active === false);
  if (release) {
    expect(release.statusCode).toBe(204);
    expect(elapsedMs).toBeLessThan(40_000);
  } else {
    expect(elapsedMs).toBeGreaterThanOrEqual(100_000);
  }
});

scenario('обзор включает начальный баланс только по переключателю', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  await request.put('/api/operations/opening-balance', { data: { accountId: data.accounts[0].id, amount: 1234, date: '2026-10-03' } });
  await page.goto('/#overview');
  const income = page.locator('[data-overview-metric="income"] .metric-value');
  const before = await income.textContent();
  await page.locator('#overview-opening-toggle').check();
  await expect(income).not.toHaveText(before);
  await page.locator('#overview-direction').selectOption('income');
  await expect(page.locator('.category-list')).toContainText('Начальный баланс');
  await page.locator('#overview-opening-toggle').uncheck();
  await expect(income).toHaveText(before);
  await expect(page.locator('.category-list')).not.toContainText('Начальный баланс');
});

scenario('ошибка сохранения начального баланса показывается попапом', async ({ page }) => {
  await page.route('**/api/operations/opening-balance', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Курс ЦБ недоступен', code: 'UPSTREAM_UNAVAILABLE', retryable: true }) }));
  await page.goto('/#operations');
  await page.getByRole('tab', { name: 'Начальные балансы' }).click();
  await page.locator('#opening-balance-form [name="amount"]').fill('20');
  const popup = page.waitForEvent('dialog');
  await page.locator('#opening-balance-form button[type="submit"]').click();
  const dialog = await popup;
  expect(dialog.message()).toContain('Начальный баланс не сохранён');
  await dialog.accept();
});

scenario('сумма форматируется тысячами и сохраняется без потери точности', async ({ page, request }) => {
  await page.goto('/#overview');
  await page.locator('[data-action="add-operation"]').click();
  const form = page.locator('#operation-form');
  await form.locator('[name="amount"]').fill('1234567.123456');
  await expect(form.locator('[name="amount"]')).toHaveValue('1,234,567.123456');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('7654321.111111'));
  await form.locator('[name="amount"]').fill('');
  await form.locator('[name="amount"]').focus();
  await page.keyboard.press('Control+V');
  await expect(form.locator('[name="amount"]')).toHaveValue('7,654,321.111111');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/operations') && response.request().method() === 'POST');
  await page.locator('#save-operation').click();
  expect((await saved).ok()).toBeTruthy();
  const data = await (await request.get('/api/data')).json();
  expect(data.operations.some((item) => item.amount === 7654321.111111)).toBeTruthy();
});

scenario('new ordinary account immediately has a dated zero opening balance', async ({ page, request }) => {
  const name = 'New account zero opening';
  const response = await request.put('/api/accounts', { data: { accounts: [{ name, currency: 'RUB', rate: 1 }] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = await response.json();
  const accountId = created.result.created[0];
  const opening = created.data.openingBalances.find((item) => item.accountId === accountId);
  expect(opening).toMatchObject({ amount: 0, date: '2026-10-16', rate: 1 });

  await page.goto('/#operations');
  await page.locator('[data-operations-section="opening-balances"]').click();
  const row = page.locator('.opening-balance-table tbody tr').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator('td').first()).not.toBeEmpty();
  await expect(row.locator('td').nth(3)).toHaveText('1');
  await expect(row).toContainText('0');
});

scenario('a new foreign account shows a popup and stays unsaved without its CBR rate', async ({ page }) => {
  await page.route(/\/api\/rates\?currency=USD/, (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Служба курсов недоступна. Повторите запрос позже.', code: 'EXTERNAL_SERVICE', retryable: true }),
  }));
  await page.goto('/#balance');
  await page.locator('[data-add-account]').click();
  const currency = page.locator('.new-account-row [name="currency"]');
  const popupPromise = page.waitForEvent('dialog');
  const selectionPromise = currency.selectOption('USD');
  const popup = await popupPromise;
  expect(popup.message()).toContain('Валютный счёт с начальным балансом 0 нельзя сохранить без курса.');
  await popup.accept();
  await selectionPromise;
  expect(await page.locator('.new-account-row [name="rate"]').evaluate((input) => input.validity.valid)).toBe(false);
  await expect(page.locator('.new-account-row')).toBeVisible();
});

scenario('amount fields reject letters and unsupported symbols', async ({ page }) => {
  await page.goto('/#overview');
  await page.locator('[data-action="add-operation"]').click();
  const amount = page.locator('#operation-form [name="amount"]');
  await amount.fill('12abc$');
  expect(await amount.evaluate((input) => input.validity.valid)).toBe(false);
  const operationPosts = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/operations') && request.method() === 'POST') operationPosts.push(request);
  });
  await page.locator('#save-operation').click();
  await expect(page.locator('#operation-dialog')).toBeVisible();
  expect(operationPosts).toHaveLength(0);

  await amount.fill('');
  await amount.pressSequentially('12abc$');
  await expect(amount).toHaveValue('12');
});

scenario('структура обзора прокручивается при длинном списке и показывает пустую группу', async ({ page }) => {
  let manyCategories = false;
  await page.route('**/api/data', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (!manyCategories) { await route.fulfill({ response, body: JSON.stringify(data) }); return; }
    const account = data.accounts[0];
    const lots = Array.from({ length: 24 }, (_, index) => ({
      name: `UI Long Category ${String(index).padStart(2, '0')}`,
      type: 'Расход',
      emoji: '📌',
    }));
    data.lists.categories.push(...lots);
    data.operations = lots.map((category, index) => ({
      id: index + 1000,
      date: '2026-10-03',
      type: 'Расход',
      category: category.name,
      amount: 1,
      currency: account.currency,
      rate: account.rate,
      rubAmount: 1,
      necessity: 'Обязательная',
      accountId: account.id,
      notes: '',
    }));
    await route.fulfill({ response, body: JSON.stringify(data) });
  });
  await page.goto('/#overview');
  let firstWidth = true;
  for (const width of [1280, 900, 390]) {
    if (!firstWidth) { manyCategories = false; await page.reload(); }
    firstWidth = false;
    await page.setViewportSize({ width, height: 900 });
    const before = await page.locator('.spending-card').evaluate((card) => card.getBoundingClientRect().height);
    manyCategories = true;
    await page.reload();
    await expect(page.locator('.category-row')).toHaveCount(24);
    const geometry = await page.locator('.spending-card').evaluate((card) => {
      const list = card.querySelector('.category-list');
      return {
        cardHeight: card.getBoundingClientRect().height,
        mainHeight: document.querySelector('.overview-main').getBoundingClientRect().height,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        overflowY: getComputedStyle(list).overflowY,
        touchAction: getComputedStyle(list).touchAction,
        focusable: list.tabIndex === 0,
      };
    });
    expect(Math.abs(geometry.cardHeight - before)).toBeLessThanOrEqual(1);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.overflowY).toBe('auto');
    expect(geometry.touchAction).not.toBe('none');
    expect(geometry.focusable).toBeTruthy();
    if (width > 1050) expect(Math.abs(geometry.mainHeight - geometry.cardHeight)).toBeLessThanOrEqual(1);
    if (width === 1280) {
      const list = page.locator('.category-list');
      await list.focus();
      await page.keyboard.press('End');
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await list.evaluate((element) => { element.scrollTop = 0; });
      await list.hover();
      await page.mouse.wheel(0, 160);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }
    manyCategories = false;
  }
  await page.locator('#overview-direction').selectOption('income');
  await expect(page.locator('.category-list .empty-state')).toBeVisible();
});

scenario('категории истории группируются по периоду и остальным фильтрам', async ({ page, request }) => {
  const data = await (await request.get('/api/data')).json();
  const category = data.lists.categories.find((item) => item.type === 'Доход');
  const created = await request.post('/api/operations', { data: { date: data.asOfDate, type: 'Доход', category: category.name, accountId: data.accounts[0].id, amount: 100, currency: data.accounts[0].currency, rate: data.accounts[0].rate, notes: 'unique-category-filter' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await page.goto('/#operations');
  await page.locator('#operation-search').fill('unique-category-filter');
  await expect(page.locator('#operation-category optgroup').first().locator('option')).toHaveCount(1);
  await expect(page.locator('#operation-category optgroup').first()).toContainText(category.name);
  await page.locator('#operation-month').fill('2026-09');
  await expect(page.locator('#operation-category optgroup').first().locator('option')).toHaveCount(0);
  await expect(page.locator('#operation-category optgroup').last()).toContainText(category.name);
});

scenario('загрузка обновления показывает проценты и неопределённый прогресс', async ({ page }) => {
  await page.route('**/api/updates/check', (route) => route.fulfill({ json: { enabled: true, currentVersion: '1.2.2', channel: 'stable', update: { version: '1.3.0', channel: 'stable', url: 'https://github.com/gmdveast/finance-desktop/releases/tag/v1.3.0' } } }));
  let total = null;
  await page.route('**/api/updates/progress', (route) => route.fulfill({ json: { stage: 'downloading', received: 50, total } }));
  let complete;
  const gate = new Promise((resolve) => { complete = resolve; });
  await page.route('**/api/updates/install', async (route) => { await gate; await route.fulfill({ status: 202, json: { queued: true, version: '1.3.0' } }); });
  await page.goto('/#settings');
  await page.locator('[data-check-update]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-install-update]').click();
  await expect(page.locator('progress')).not.toHaveAttribute('value');
  total = 100;
  await expect(page.locator('[data-install-update]')).toHaveText('Загрузка: 50%');
  await expect(page.locator('progress')).toHaveAttribute('value', '50');
  complete();
  await expect(page.locator('progress')).toHaveCount(0);
});

if (process.env.FINANCE_TEST_REVERSE === '1') scenarios.reverse();
for (const [name, run] of scenarios) test(name, run);
