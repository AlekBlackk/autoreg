(function (global) {
  'use strict';
  const RegLog = global.RegLog = global.RegLog || {};
  const agent = RegLog.agent = {};

  agent.pageAgent = async function pageAgent(payload) {
    const RX = {
      email:   /e-?mail|почт|mail/,
      user:    /user|login|nick|account|логин|никнейм|пользовател/,
      confirm: /confirm|repeat|retype|again|verify|повтор|подтвер|ещё раз|еще раз/,
      name:    /\b(full-?name|first-?name|display-?name|name)\b|\bимя\b|фамили/
    };
    const RX_REJECT = /disposable|temporar|throwaway|not allowed|not permitted|invalid e-?mail|blocked|одноразов|временн|недопустим|некорректн|запрещ|не поддерживается/i;

    function collect(root, out) {
      for (const el of root.querySelectorAll('input, textarea')) {
        out.push(el);
        if (el.shadowRoot) collect(el.shadowRoot, out);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(el.shadowRoot, out);
      }
    }

    function isCandidate(el) {
      const badType = /^(hidden|submit|button|checkbox|radio|file|image|reset|search)$/i;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (badType.test(type)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      const visible = (el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      if (!visible) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden') return false;
      return true;
    }

    function metaString(el) {
      const parts = [
        el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.className,
        el.getAttribute('autocomplete'), el.getAttribute('aria-label')
      ];
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          const node = el.ownerDocument.getElementById(id);
          if (node) parts.push(node.textContent);
        }
      }
      if (el.labels && el.labels[0]) parts.push(el.labels[0].textContent);
      const closestLabel = el.closest('label');
      if (closestLabel) parts.push(closestLabel.textContent);
      return parts.filter(Boolean).join(' ').toLowerCase();
    }

    function classify(candidates) {
      const found = { name: null, username: null, email: null, password: null, confirm: null };

      const byAutocomplete = (val) => candidates.filter(el => (el.getAttribute('autocomplete') || '').toLowerCase() === val);

      const newPasswordFields = byAutocomplete('new-password');
      if (newPasswordFields[0]) found.password = newPasswordFields[0];
      if (newPasswordFields[1]) found.confirm = newPasswordFields[1];

      if (!found.username) { const m = byAutocomplete('username')[0]; if (m) found.username = m; }
      if (!found.email) { const m = byAutocomplete('email')[0]; if (m) found.email = m; }
      if (!found.name) {
        const m = byAutocomplete('name')[0] || byAutocomplete('given-name')[0] || byAutocomplete('family-name')[0];
        if (m) found.name = m;
      }

      const remaining = () => candidates.filter(el => ![found.name, found.username, found.email, found.password, found.confirm].includes(el));

      if (!found.password) {
        const pwCandidates = remaining().filter(el => {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (type === 'password') return true;
          const meta = metaString(el);
          return /password|пароль/.test(meta) && (el.dataset && Object.values(el.dataset).some(v => /password/i.test(v)));
        });
        const pwCandidatesLoose = remaining().filter(el => (el.getAttribute('type') || 'text').toLowerCase() === 'password');
        const pool = pwCandidatesLoose.length ? pwCandidatesLoose : pwCandidates;
        if (pool.length === 1) {
          found.password = pool[0];
        } else if (pool.length >= 2) {
          const main = pool.find(el => !RX.confirm.test(metaString(el)));
          found.password = main || pool[0];
          const rest = pool.filter(el => el !== found.password);
          found.confirm = rest.find(el => RX.confirm.test(metaString(el))) || rest[0] || null;
        }
      }

      if (!found.email) {
        const typeEmail = remaining().find(el => (el.getAttribute('type') || '').toLowerCase() === 'email');
        found.email = typeEmail || remaining().find(el => RX.email.test(metaString(el)) && !RX.confirm.test(metaString(el))) || null;
      }

      if (!found.username) {
        found.username = remaining().find(el => RX.user.test(metaString(el))) || null;
      }

      if (!found.name) {
        found.name = remaining().find(el => RX.name.test(metaString(el))) || null;
      }

      return found;
    }

    function setValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      el.focus();
      desc.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return el.value;
    }

    async function setValueSlow(el, value) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      let acc = '';
      for (const ch of value) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new InputEvent('beforeinput', { data: ch, bubbles: true, cancelable: true, inputType: 'insertText' }));
        acc += ch;
        desc.set.call(el, acc);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        const delay = 15 + Math.floor(Math.random() * 26);
        await new Promise(r => setTimeout(r, delay));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return el.value;
    }

    async function watchReject(emailEl, watchMs) {
      const scope = emailEl.closest('form') || emailEl.parentElement;
      const check = () => {
        if (emailEl.validationMessage && RX_REJECT.test(emailEl.validationMessage))
          return emailEl.validationMessage;
        const nodes = scope.querySelectorAll(
          '[role="alert"], [aria-live], [class*="error"], [class*="invalid"], [class*="danger"], [class*="warn"]'
        );
        for (const n of nodes) {
          const t = (n.textContent || '').trim();
          if (t && RX_REJECT.test(t)) return t;
        }
        if (emailEl.getAttribute('aria-invalid') === 'true') {
          const id = emailEl.getAttribute('aria-describedby');
          const d = id && document.getElementById(id);
          if (d && RX_REJECT.test(d.textContent || '')) return d.textContent.trim();
        }
        return null;
      };
      const first = check();
      if (first) return first;
      return new Promise(resolve => {
        const obs = new MutationObserver(() => { const r = check(); if (r) { obs.disconnect(); resolve(r); } });
        obs.observe(scope, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-invalid'] });
        setTimeout(() => { obs.disconnect(); resolve(null); }, watchMs);
      });
    }

    const candidates = [];
    collect(document, candidates);
    const visible = candidates.filter(isCandidate);
    const found = classify(visible);

    const limits = {
      password: found.password ? (found.password.maxLength > 0 ? found.password.maxLength : 0) : 0,
      username: found.username ? (found.username.maxLength > 0 ? found.username.maxLength : 0) : 0,
      email: found.email ? (found.email.maxLength > 0 ? found.email.maxLength : 0) : 0
    };

    const score = (found.email ? 2 : 0) + (found.password ? 2 : 0)
      + (found.username ? 1 : 0) + (found.name ? 1 : 0) + (found.confirm ? 1 : 0);

    const result = {
      found: {
        name: !!found.name, username: !!found.username, email: !!found.email,
        password: !!found.password, confirm: !!found.confirm
      },
      limits, filled: [], actual: {}, truncated: [],
      emailRejected: false, rejectText: null,
      frameUrl: location.href, score
    };

    if (payload.mode === 'scan') return result;

    const data = payload.data || {};
    const opts = payload.opts || {};
    const write = opts.slowType ? setValueSlow : (el, v) => Promise.resolve(setValue(el, v));

    const order = payload.mode === 'fillEmail'
      ? [['email', found.email, data.email]]
      : [
          ['name', found.name, data.name],
          ['username', found.username, data.username],
          ['email', found.email, data.email],
          ['password', found.password, data.password],
          ['confirm', found.confirm, data.password]
        ];

    let scrolled = false;
    let lastEl = null;
    for (const [key, el, value] of order) {
      if (!el || value == null) continue;
      if (!scrolled) { el.scrollIntoView({ block: 'center', behavior: 'auto' }); scrolled = true; }
      const actualValue = await write(el, String(value));
      result.filled.push(key);
      result.actual[key] = actualValue;
      if (actualValue !== String(value)) result.truncated.push(key);
      lastEl = el;
    }
    if (lastEl) lastEl.focus();

    if ((payload.mode === 'fill' || payload.mode === 'fillEmail') && found.email) {
      const watchMs = opts.watchMs || 3000;
      const rejectText = await watchReject(found.email, watchMs);
      if (rejectText) {
        result.emailRejected = true;
        result.rejectText = rejectText.slice(0, 120);
      }
    }

    return result;
  };

})(typeof window !== 'undefined' ? window : globalThis);
