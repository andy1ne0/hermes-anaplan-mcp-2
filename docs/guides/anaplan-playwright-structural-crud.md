# Anaplan Playwright Structural CRUD for Simple Agents

Purpose: a deterministic, copy-pasteable method for less capable agents to create Anaplan **General Lists** and **Modules** through the browser UI only. Do **not** use Anaplan REST/API endpoints for the write.

This method was validated against:
- Region/login host: `https://au1a.app2.anaplan.com`
- Login URL: `https://au1a.app2.anaplan.com/auth/prelogin?service=https%3A%2F%2Fau1a.app2.anaplan.com%2Fhome&useCas=false`
- Model: `carrick - mcp`
- General Lists page: existing `profitCentre`, `CostCentre`, `Organization`

## Golden Rules

1. Use browser/Playwright UI only for the create action. No Anaplan API write endpoints.
2. Always take screenshots after each major step into `/tmp/anaplan-ui-debug/`.
3. Never rely on Anaplan DOM locators on the model list page. The visible grid may be inaccessible to JS/Playwright selectors.
4. Once inside a model, use the nested iframe pattern:
   - outer iframe: `iframe[name="App shell content"]`
   - inner iframe: the first iframe inside the outer iframe; this contains the legacy Anaplan/Dojo grid.
5. For grid toolbar/dialog buttons (`Insert...`, `OK`, `Cancel`), click Dojo widgets through `innerWin.dijit.byId(id).onClick()`; normal `.click()` is unreliable.
6. Widget IDs are dynamic. Find buttons by visible label text, strip `_label`, then call `dijit.byId(baseId).onClick()`.
7. Verify exact names after create. Do not case-fold success checks. An existing `profitCentre` blocks lowercase `profitcentre` and may leave the Insert dialog open without an obvious error.

## Install/Preflight

```bash
mkdir -p /tmp/pw-anaplan
cd /tmp/pw-anaplan
npm init -y >/dev/null
npm install playwright --no-audit --no-fund
npx playwright install chromium
node -e "require('playwright'); console.log('playwright ok')"
python3 - <<'PY'
import os
for k in ['ANAPLAN_USERNAME','ANAPLAN_PASSWORD']:
    assert os.environ.get(k), f'{k} missing'
print('anaplan env ok')
PY
```

Do not print secret values. Only check that env vars exist.

## Login Flow

Use the user-facing login URL exactly:

```text
https://au1a.app2.anaplan.com/auth/prelogin?service=https%3A%2F%2Fau1a.app2.anaplan.com%2Fhome&useCas=false
```

Steps:
1. Navigate to login URL.
2. Fill email from `$ANAPLAN_USERNAME`.
3. Click `Continue`.
4. If presented, click `Anaplan login (with email and password)`.
5. Fill password from `$ANAPLAN_PASSWORD`.
6. Click `Log in`.
7. Wait 8-15 seconds for SPA load.
8. Screenshot `after-login`.

## Open Target Model

1. Navigate to `https://au1a.app2.anaplan.com/home/models`.
2. Screenshot `models-list`.
3. If a `Find...` field is visible, use **keyboard/mouse coordinates** if Playwright locators cannot see it:
   - click around `(180,126)` on a 1600x1000 viewport,
   - `Ctrl+A`, type model name,
   - wait 3-4 seconds,
   - screenshot `models-filtered`.
4. Try normal locators first:
   - `page.getByRole('link', { name: /model name/i })`
   - `page.getByText(modelName, { exact: true })`
5. If locators fail but screenshot shows the model, click the visible row coordinate.
   - In the validated 1600x1000 layout, `carrick - mcp` first-row text was around `(105,257)`.
6. Wait 15 seconds.
7. Screenshot `model-opened`.
8. Verify the opened page visually/breadcrumb contains the target model before continuing.

## Navigate to Structural Area

For General Lists:
- Prefer `page.frameLocator('iframe[name="App shell content"]').getByText(/General lists/i).click()`.
- If that fails, use visual coordinate fallback. In the validated 1600x1000 layout, `General lists` was around `(110,228)`.
- Wait 8 seconds and screenshot `general-lists`.

For Modules:
- Prefer `page.frameLocator('iframe[name="App shell content"]').getByText(/^Modules$/i).click()`.
- If that fails, use the sidebar coordinate for `Modules` (below `General lists`) and verify the inner grid header/content mentions module rows.
- Wait 8 seconds and screenshot `modules`.

## Reusable Inner-Iframe Helpers

Use these helpers in standalone Playwright scripts after the model page is open.

```javascript
async function innerEval(page, fn, arg) {
  return await page.evaluate(async ({ fnText, arg }) => {
    const getDocs = () => {
      const outer = document.querySelector('iframe');
      if (!outer) throw new Error('outer iframe not found');
      const outerDoc = outer.contentDocument;
      const inner = outerDoc && outerDoc.querySelector('iframe');
      if (!inner) throw new Error('inner iframe not found');
      return { outer, outerDoc, inner, innerDoc: inner.contentDocument, innerWin: inner.contentWindow };
    };
    return await (new Function('getDocs', 'arg', `return (${fnText})(getDocs, arg);`))(getDocs, arg);
  }, { fnText: fn.toString(), arg });
}

async function clickDijitByLabel(page, labelRegexSource) {
  return await innerEval(page, (getDocs, source) => {
    const { innerDoc, innerWin } = getDocs();
    const re = new RegExp(source, 'i');
    const els = [...innerDoc.querySelectorAll('*')];
    const labels = els.filter(el => re.test((el.textContent || '').trim()));
    for (const el of labels) {
      let id = el.id || '';
      if (id.endsWith('_label')) id = id.slice(0, -6);
      let cur = el;
      while (!id && cur && cur !== innerDoc.body) {
        cur = cur.parentElement;
        id = cur?.id || '';
      }
      if (id && innerWin.dijit && innerWin.dijit.byId(id)) {
        innerWin.dijit.byId(id).onClick();
        return { clicked: id, text: el.textContent.trim() };
      }
      if (el.click) {
        el.click();
        return { clickedDom: el.id || el.tagName, text: el.textContent.trim() };
      }
    }
    return { clicked: null, labels: labels.slice(0, 10).map(e => ({ id: e.id, text: e.textContent.trim().slice(0, 80), cls: e.className })) };
  }, labelRegexSource);
}

async function visibleInnerText(page, max = 10000) {
  return await innerEval(page, (getDocs, max) => getDocs().innerDoc.body.innerText.slice(0, max), max);
}

function exactLineExists(text, name) {
  return text.split(/\n+/).map(s => s.trim()).includes(name);
}
```

## Create a General List

Precondition: you are on the **General lists** page and `visibleInnerText()` starts with toolbar text like `Open`, `Insert...`, `Delete...`, `Reorder...`.

Algorithm:

```javascript
async function createGeneralList(page, listName) {
  const before = await visibleInnerText(page);
  if (exactLineExists(before, listName)) return { status: 'already-exists-exact', name: listName };

  const caseConflict = before.split(/\n+/).map(s => s.trim()).find(s => s.toLowerCase() === listName.toLowerCase());
  if (caseConflict) return { status: 'already-exists-case-conflict', requested: listName, existing: caseConflict };

  const insert = await clickDijitByLabel(page, '^Insert\\.\\.\\.$|^Insert');
  if (!insert.clicked && !insert.clickedDom) throw new Error('Insert button not clicked: ' + JSON.stringify(insert));
  await page.waitForTimeout(1500);

  const filled = await innerEval(page, (getDocs, name) => {
    const { innerDoc, innerWin } = getDocs();
    const candidates = [...innerDoc.querySelectorAll('textarea.itemNamesTextArea, textarea[id^="dijit_form_SimpleTextarea"], textarea')]
      .map(t => ({ el: t, r: t.getBoundingClientRect(), id: t.id, cls: String(t.className || '') }))
      .filter(x => x.r.width > 50 && x.r.height > 20);
    const textarea = (candidates[0] && candidates[0].el) || innerDoc.querySelector('textarea');
    if (!textarea) return { filled: false };
    textarea.focus();
    textarea.value = name;
    if (innerWin.dijit) {
      const w = textarea.id && innerWin.dijit.byId(textarea.id);
      if (w && w.set) w.set('value', name);
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'e' }));
    return { filled: true, id: textarea.id, value: textarea.value };
  }, listName);
  if (!filled.filled) throw new Error('List-name textarea not found');

  const ok = await clickDijitByLabel(page, '^OK$');
  if (!ok.clicked && !ok.clickedDom) throw new Error('OK button not clicked: ' + JSON.stringify(ok));
  await page.waitForTimeout(8000);

  const after = await visibleInnerText(page);
  const dialogStillOpen = after.includes('Insert into General Lists');
  if (exactLineExists(after, listName) && !dialogStillOpen) return { status: 'created', name: listName };
  if (exactLineExists(after, listName)) return { status: 'visible-but-dialog-open-check-manually', name: listName };
  throw new Error('Create list failed or blocked. Dialog still open=' + dialogStillOpen + ' text=' + after.slice(0, 500));
}
```

Important duplicate rule:
- If `profitCentre` exists and requested name is `profitcentre`, return `already-exists-case-conflict`. Do not try to force-create the lowercase duplicate.

## Create a Module

Precondition: you are on the **Modules** page and the inner grid toolbar is visible.

The module grid uses the same Anaplan/Dojo pattern as General Lists.

Algorithm:

```javascript
async function createModule(page, moduleName) {
  const before = await visibleInnerText(page);
  if (exactLineExists(before, moduleName)) return { status: 'already-exists-exact', name: moduleName };

  const caseConflict = before.split(/\n+/).map(s => s.trim()).find(s => s.toLowerCase() === moduleName.toLowerCase());
  if (caseConflict) return { status: 'already-exists-case-conflict', requested: moduleName, existing: caseConflict };

  const insert = await clickDijitByLabel(page, '^Insert\\.\\.\\.$|^Insert');
  if (!insert.clicked && !insert.clickedDom) throw new Error('Insert button not clicked: ' + JSON.stringify(insert));
  await page.waitForTimeout(1500);

  const filled = await innerEval(page, (getDocs, name) => {
    const { innerDoc, innerWin } = getDocs();
    // Module Insert dialog also uses a visible textarea/text input depending on UI state.
    const fields = [...innerDoc.querySelectorAll('textarea, input[type="text"], .dijitInputInner')]
      .map(el => ({ el, r: el.getBoundingClientRect(), id: el.id, cls: String(el.className || '') }))
      .filter(x => x.r.width > 50 && x.r.height > 10 && !x.el.disabled && x.el.offsetParent !== null);
    const field = fields[0] && fields[0].el;
    if (!field) return { filled: false, fields: fields.map(f => ({ id: f.id, cls: f.cls, rect: {x:f.r.x,y:f.r.y,w:f.r.width,h:f.r.height} })) };
    field.focus();
    field.value = name;
    if (innerWin.dijit) {
      const w = field.id && innerWin.dijit.byId(field.id);
      if (w && w.set) w.set('value', name);
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'e' }));
    return { filled: true, id: field.id, cls: field.className, value: field.value };
  }, moduleName);
  if (!filled.filled) throw new Error('Module-name input not found: ' + JSON.stringify(filled));

  const ok = await clickDijitByLabel(page, '^OK$');
  if (!ok.clicked && !ok.clickedDom) throw new Error('OK button not clicked: ' + JSON.stringify(ok));
  await page.waitForTimeout(8000);

  const after = await visibleInnerText(page);
  const dialogStillOpen = after.includes('Insert into Modules') || after.includes('New Module') || after.includes('Create Module');
  if (exactLineExists(after, moduleName) && !dialogStillOpen) return { status: 'created', name: moduleName };
  if (exactLineExists(after, moduleName)) return { status: 'visible-but-dialog-open-check-manually', name: moduleName };
  throw new Error('Create module failed or blocked. Dialog still open=' + dialogStillOpen + ' text=' + after.slice(0, 500));
}
```

If the Modules dialog asks for dimensions/applies-to before creation, use the default/no-dimension module first unless the user explicitly requested dimensionality. Less capable agents should not infer dimensionality.

## Verification Checklist

For every run, report:

- login URL used
- target model name
- target area: `General lists` or `Modules`
- requested object name
- exact existing-name check result
- case-conflict result if any
- final status: `created`, `already-exists-exact`, `already-exists-case-conflict`, or `failed`
- screenshot paths for:
  - `models-list`
  - `model-opened`
  - target page (`general-lists` or `modules`)
  - after `OK`

Never report success unless the exact object name appears as a trimmed line in the grid after the dialog closes.
