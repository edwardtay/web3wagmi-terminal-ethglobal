/*!
 * Malaysia4U feedback widget.
 *
 * ONE implementation for the apex and every subdomain. The sites are separate
 * origins on different stacks (Next.js apps plus a PHP one), so a React
 * component could not be shared, and a copy per site would drift the way the old
 * FeedbackBanner did. This file is served from https://malaysia4u.com and
 * included with a single script tag everywhere:
 *
 *   <script src="https://malaysia4u.com/feedback-widget.js" defer></script>
 *
 * Deliberately unintrusive: a 26px translucent tab on the right edge, no modal,
 * no overlay, no auto-open, nothing that shifts layout. It is invisible until
 * someone looks for it.
 *
 * Submits to our own https://malaysia4u.com/api/feedback so the visitor stays on
 * the page they were reading. That endpoint stores the message before it tries
 * to notify anyone, which is why it replaced posting straight to FormSubmit:
 * FormSubmit's plain form POST rendered "submitted successfully" for messages
 * that never arrived, and with nothing stored there was no way to know what had
 * been lost. A failed request is now reported to the sender rather than
 * navigating them somewhere that claims success.
 *
 * No dependencies, no framework, no globals beyond one guard flag. Styles are
 * scoped under .m4u-fb- and injected once.
 */
(function () {
  'use strict'
  if (window.__m4uFeedbackWidget) return
  window.__m4uFeedbackWidget = true
  if (typeof document === 'undefined') return

  // Per-brand configuration, read off this file's own <script> tag so one
  // identical file serves every site:
  //
  //   <script src="/feedback-widget.js" data-email="hi@pwnsy.com"
  //           data-accent="#2ee6a6" defer></script>
  //
  // Only the mailto fallback and the accent colour come from here. The address
  // mail is actually delivered to is decided server-side from the request
  // Origin, never from this attribute, so editing it in devtools redirects
  // nothing.
  var SELF =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[src*="feedback-widget"]')
      return all.length ? all[all.length - 1] : null
    })()
  var CFG = (SELF && SELF.dataset) || {}

  var EMAIL = CFG.email || 'hi@malaysia4u.com'
  // Absolute, because the widget runs on other origins entirely and the
  // endpoint lives on the apex. It answers CORS for known brand hosts only.
  var ENDPOINT = CFG.endpoint || 'https://malaysia4u.com/api/feedback'
  // Last resort, from the browser only. FormSubmit refuses our server's IP but
  // accepts a real visitor, and this AJAX endpoint reports a truthful result:
  // it is their plain form POST that claims success without delivering, and
  // that path is gone. Reached only when our own endpoint is unreachable.
  var FALLBACK = CFG.fallback === 'formsubmit' ? 'https://formsubmit.co/ajax/' + EMAIL : null
  var ROSE = CFG.accent || '#f43f5e'
  var ROSE_DARK = CFG.accentDark || shade(ROSE, -18)

  // The focus ring is the accent at low opacity.
  function rgba(hex, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) return 'rgba(244,63,94,' + a + ')'
    var n = parseInt(m[1], 16)
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
  }

  // Darken the accent for the hover state so a brand only has to supply one
  // colour. Falls back to the input if it is not a plain 6-digit hex.
  function shade(hex, pct) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex)
    if (!m) return hex
    var n = parseInt(m[1], 16)
    var out = []
    for (var i = 0; i < 3; i++) {
      var c = (n >> (16 - i * 8)) & 255
      c = Math.round(c + (pct / 100) * 255)
      out.push(Math.max(0, Math.min(255, c)))
    }
    return '#' + out.map(function (c) { return ('0' + c.toString(16)).slice(-2) }).join('')
  }

  var css =
    '.m4u-fb-tab{position:fixed;right:0;bottom:88px;z-index:2147482900;width:26px;height:48px;padding:0;border:0;' +
    'border-radius:11px 0 0 11px;background:' + ROSE + ';color:#fff;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;box-shadow:-3px 3px 12px rgba(0,0,0,.16);opacity:.45;transition:opacity .2s ease,width .2s ease}' +
    '.m4u-fb-tab:hover,.m4u-fb-tab:focus-visible{opacity:1;width:32px;outline:0}' +
    '.m4u-fb-panel{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:340px;max-width:calc(100vw - 32px);' +
    'background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);overflow:hidden;' +
    'font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111827;box-sizing:border-box;' +
    'transform:translateY(12px);opacity:0;transition:transform .22s ease,opacity .22s ease}' +
    '.m4u-fb-panel.m4u-fb-in{transform:translateY(0);opacity:1}' +
    '.m4u-fb-panel *{box-sizing:border-box}' +
    '.m4u-fb-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:' + ROSE + ';color:#fff}' +
    '.m4u-fb-hd b{display:block;font-size:14px;font-weight:700}' +
    '.m4u-fb-hd span{display:block;font-size:11px;opacity:.9;overflow-wrap:anywhere}' +
    '.m4u-fb-x{flex:0 0 auto;background:0;border:0;color:#fff;opacity:.85;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px}' +
    '.m4u-fb-x:hover{opacity:1}' +
    '.m4u-fb-body{padding:14px}' +
    '.m4u-fb-body label{display:block;font-size:11px;font-weight:600;color:#374151;margin:0 0 4px}' +
    '.m4u-fb-body select,.m4u-fb-body input,.m4u-fb-body textarea{width:100%;padding:8px 10px;border:1px solid #e5e7eb;' +
    'border-radius:10px;font:inherit;font-size:13px;margin:0 0 10px;background:#fff;color:#111827}' +
    '.m4u-fb-body textarea{resize:vertical;min-height:64px}' +
    '.m4u-fb-body select:focus,.m4u-fb-body input:focus,.m4u-fb-body textarea:focus{outline:0;border-color:' + ROSE + ';box-shadow:0 0 0 3px ' + rgba(ROSE, 0.18) + '}' +
    '.m4u-fb-send{width:100%;padding:10px;border:0;border-radius:10px;background:' + ROSE + ';color:#fff;font-weight:700;' +
    'font-size:13px;cursor:pointer}' +
    '.m4u-fb-send:hover{background:' + ROSE_DARK + '}' +
    '.m4u-fb-send[disabled]{opacity:.6;cursor:default}' +
    '.m4u-fb-msg{margin:10px 0 0;font-size:12px;overflow-wrap:anywhere}' +
    '.m4u-fb-ok{color:#15803d}.m4u-fb-err{color:#b91c1c}' +
    '@media (max-width:420px){.m4u-fb-panel{right:8px;left:8px;width:auto;bottom:8px}}' +
    '@media (prefers-reduced-motion:reduce){.m4u-fb-tab,.m4u-fb-panel{transition:none}}'

  var style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  var CHAT_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>'

  var tab = document.createElement('button')
  tab.className = 'm4u-fb-tab'
  tab.type = 'button'
  tab.setAttribute('aria-label', 'Send feedback or a partnership enquiry')
  tab.innerHTML = CHAT_ICON

  var panel = null
  var openedAt = 0

  // Cheap, zero-friction spam checks. None of these inconvenience a real person,
  // and together they stop the bulk of automated submissions, which are what
  // actually fills the inbox. A captcha would stop more and cost every genuine
  // sender a puzzle; that lever stays available if these prove insufficient.
  // form.elements, never form.<name>. HTMLFormElement already owns properties
  // called `name`, `action`, `method` and `target`, and those win over the
  // named-control lookup, so `form.name` returns the form's name attribute and
  // `form.name.value` is undefined. That silently dropped the sender's name
  // from every submission.
  function field(form, n) {
    var el = form.elements[n]
    return el ? String(el.value || '') : ''
  }

  function spamReason(form) {
    if (field(form, '_honey')) return 'honeypot'
    // Nobody reads four labels, types a name, an email and a message in under
    // three seconds. Scripted fills are instant.
    if (Date.now() - openedAt < 3000) return 'too_fast'
    var msg = field(form, 'message')
    var links = (msg.match(/https?:\/\/|www\.|\[url/gi) || []).length
    if (links >= 2) return 'links'
    // Bots routinely paste a URL or BBCode into the name field.
    if (/https?:\/\/|www\.|\[url|<a\s/i.test(field(form, 'name'))) return 'name_url'
    if (msg.replace(/\s+/g, ' ').trim().length < 12) return 'too_short'
    return null
  }

  function close() {
    if (!panel) return
    panel.remove()
    panel = null
    tab.style.display = ''
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('mousedown', onOutside)
  }

  function onKey(e) { if (e.key === 'Escape') close() }
  function onOutside(e) { if (panel && !panel.contains(e.target)) close() }

  function open() {
    if (panel) return
    tab.style.display = 'none'
    panel = document.createElement('div')
    panel.className = 'm4u-fb-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Get in touch')
    panel.innerHTML =
      '<div class="m4u-fb-hd"><div><b>Get in touch</b><span>Deals, partnerships or feedback</span></div>' +
      '<button type="button" class="m4u-fb-x" aria-label="Close">&times;</button></div>' +
      '<div class="m4u-fb-body"><form novalidate="false">' +
      // Honeypot. FormSubmit discards any submission where _honey is filled, and
      // bots fill every field they find. Hidden from sight AND from assistive
      // tech, with autocomplete off so a browser never fills it for a real person.
      '<input type="text" name="_honey" tabindex="-1" autocomplete="off" aria-hidden="true" ' +
      'style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0" />' +
      '<label for="m4u-fb-type">Type</label>' +
      '<select id="m4u-fb-type" name="type" required>' +
      '<option value="" disabled selected>Select...</option>' +
      '<option value="submit-deal">Submit a deal or event</option>' +
      '<option value="partnership">Partnership enquiry</option>' +
      '<option value="feedback">General feedback</option></select>' +
      '<label for="m4u-fb-name">Name</label>' +
      '<input id="m4u-fb-name" name="name" type="text" required placeholder="Your name">' +
      '<label for="m4u-fb-email">Email</label>' +
      '<input id="m4u-fb-email" name="email" type="email" required placeholder="your@email.com">' +
      '<label for="m4u-fb-message">Message</label>' +
      '<textarea id="m4u-fb-message" name="message" rows="3" required placeholder="Tell us more..."></textarea>' +
      '<button type="submit" class="m4u-fb-send">Send &rarr;</button>' +
      '<p class="m4u-fb-msg" role="status" aria-live="polite"></p>' +
      '</form></div>'

    openedAt = Date.now()
    document.body.appendChild(panel)
    // Next frame, so the transition has a starting state to animate from.
    requestAnimationFrame(function () { panel && panel.classList.add('m4u-fb-in') })

    panel.querySelector('.m4u-fb-x').addEventListener('click', close)
    var form = panel.querySelector('form')
    var msg = panel.querySelector('.m4u-fb-msg')
    var send = panel.querySelector('.m4u-fb-send')

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      if (!form.reportValidity()) return

      var bad = spamReason(form)
      if (bad) {
        // Deliberately vague and non-blocking for the honeypot and speed traps:
        // telling a bot exactly which check it tripped just helps it adapt. The
        // two content checks get a real, actionable message, because a genuine
        // person can hit those.
        msg.className = 'm4u-fb-msg m4u-fb-err'
        msg.textContent =
          bad === 'links' ? 'Please remove the links, we cannot accept them here.'
          : bad === 'name_url' ? 'That name does not look right. Please use your name.'
          : bad === 'too_short' ? 'Please add a little more detail so we can help.'
          : 'Please take a moment and try again.'
        return
      }

      send.disabled = true
      send.textContent = 'Sending...'
      msg.className = 'm4u-fb-msg'
      msg.textContent = ''

      var payload = {
        type: field(form, 'type'),
        name: field(form, 'name'),
        email: field(form, 'email'),
        message: field(form, 'message'),
        // Which site the report came from. The widget runs on every subdomain,
        // so without this every submission looks like it came from nowhere.
        page: location.href,
        _honey: field(form, '_honey'),
      }

      function fail(text) {
        if (!panel || !panel.isConnected) return
        send.disabled = false
        send.textContent = 'Send →'
        msg.className = 'm4u-fb-msg m4u-fb-err'
        msg.innerHTML = text
      }

      function ok() {
        panel.querySelector('.m4u-fb-body').innerHTML =
          '<p class="m4u-fb-msg m4u-fb-ok" style="margin:0">Thanks, that reached us. We reply to most messages within a day.</p>'
        setTimeout(close, 2600)
      }

      // Only ever reached when our endpoint could not be used at all. A 4xx from
      // it is a verdict on the submission, not an outage, and must not be
      // retried elsewhere.
      function viaFallback() {
        if (!FALLBACK) return Promise.reject(new Error('no fallback'))
        return fetch(FALLBACK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            type: payload.type,
            name: payload.name,
            email: payload.email,
            message: payload.message,
            page: payload.page,
            _subject: 'Malaysia4U Feedback',
            _template: 'table',
          }),
        }).then(function (r) {
          if (!r.ok) throw new Error('fallback http ' + r.status)
          return r.json()
        })
      }

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          return r.json().catch(function () { return {} }).then(function (b) { return { status: r.status, ok: r.ok, body: b } })
        })
        .then(function (r) {
          if (r.ok) return ok()
          // 4xx is the endpoint telling the sender what is wrong with the
          // submission (too short, a link in the name, too many at once). Show
          // its wording; it is written for them.
          if (r.status >= 400 && r.status < 500) {
            fail(String((r.body && r.body.error) || 'Please check the form and try again.'))
            return
          }
          return viaFallback().then(ok)
        })
        .catch(function () {
          // Network-level failure, so our endpoint was never reached.
          return viaFallback().then(ok).catch(function () {
            // Nothing delivered. Say exactly that, and leave what they typed on
            // screen so Send can be pressed again. No navigating away to a page
            // that claims success.
            fail('That did not send. Please email <a href="mailto:' + EMAIL + '">' + EMAIL + '</a>.')
          })
        })
    })

    document.addEventListener('keydown', onKey)
    setTimeout(function () { document.addEventListener('mousedown', onOutside) }, 0)
    panel.querySelector('#m4u-fb-type').focus()
  }

  tab.addEventListener('click', open)

  function mount() { document.body.appendChild(tab) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
})()
