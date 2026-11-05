/**
 * dsh-weknora-macos client: the WeKnora tool card.
 *
 * Registered on `tool.call.toolview` for the wire tool name `weknora_run`, so a
 * call to that tool renders this card instead of the generic tool row. The card
 * asks the host route (GET /weknora-run/api-key) what is true right now and
 * posts the key back (POST) when the user confirms.
 *
 * Built as the loader's factory bundle: no build step, `react` comes from the
 * module table the loader exposes, and everything else is plain DOM via
 * React.createElement. Styling uses the host's theme variables with neutral
 * fallbacks so the card survives a theme that does not publish them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-weknora-macos',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var ROUTE = '/weknora-run/api-key'
    var OPEN_ROUTE = '/weknora-run/open'
    var CARD_TITLE = 'WeKnora'

    var COLOR = {
      text: 'var(--dsh-color-text, #1f2328)',
      muted: 'var(--dsh-color-text-secondary, #6b7280)',
      border: 'var(--dsh-color-border, #e5e7eb)',
      surface: 'var(--dsh-color-bg-secondary, #f9fafb)',
      accent: 'var(--dsh-color-primary, #10b981)',
      danger: 'var(--dsh-color-danger, #dc2626)'
    }

    function cardStyle() {
      return {
        border: '1px solid ' + COLOR.border,
        borderRadius: 10,
        padding: '10px 12px',
        margin: '4px 0',
        background: COLOR.surface,
        color: COLOR.text,
        font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
        maxWidth: 520
      }
    }

    function rowStyle() {
      return { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
    }

    function mutedStyle() {
      return { color: COLOR.muted, fontSize: 12 }
    }

    function buttonStyle(primary) {
      return {
        border: primary ? 'none' : '1px solid ' + COLOR.border,
        background: primary ? COLOR.accent : 'transparent',
        color: primary ? '#fff' : COLOR.text,
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer'
      }
    }

    function inputStyle() {
      return {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid ' + COLOR.border,
        borderRadius: 6,
        padding: '5px 8px',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        background: 'transparent',
        color: COLOR.text
      }
    }

    /**
     * How long the card keeps re-reading while the server is not up yet.
     *
     * This must outlast a first start, not a page load: the first call creates
     * and migrates the SQLite database, which measured 6.3 s on this machine and
     * is allowed up to the plugin's 120 s `startupTimeoutMs`. The previous window
     * (8 tries x 700 ms ≈ 5.6 s) expired *before* a first boot finished, which
     * froze `running: false` into the card forever: the button then stayed
     * disabled with no explanation, and clicking it did nothing at all.
     */
    var POLL_INTERVAL_MS = 800
    var POLL_BUDGET_MS = 130000
    /** Slow down once the quick window is exhausted, so an idle tab is not chatty. */
    var POLL_SLOW_INTERVAL_MS = 3000

    function readState(setState, options) {
      var alive = true
      var timer = null
      var startedAt = Date.now()
      var opts = options || {}
      var budgetMs = typeof opts.budgetMs === 'number' ? opts.budgetMs : POLL_BUDGET_MS

      function schedule(delay) {
        timer = setTimeout(load, delay)
      }

      function load() {
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (data) {
            if (!alive) return
            setState({ loading: false, data: data, error: null })
            if (data.running === true) return
            if (Date.now() - startedAt < budgetMs) {
              var elapsed = Date.now() - startedAt
              schedule(elapsed < 30000 ? POLL_INTERVAL_MS : POLL_SLOW_INTERVAL_MS)
            }
          })
          .catch(function (error) {
            if (!alive) return
            setState({ loading: false, data: null, error: String((error && error.message) || error) })
            // The host may still be booting its web server; keep trying quietly.
            if (Date.now() - startedAt < budgetMs) schedule(POLL_SLOW_INTERVAL_MS)
          })
      }

      load()
      return function () {
        alive = false
        if (timer !== null) clearTimeout(timer)
      }
    }

    function WeknoraCard(props) {
      var statusState = React.useState({ loading: true, data: null, error: null })
      var status = statusState[0]
      var setStatus = statusState[1]
      var editingState = React.useState(false)
      var editing = editingState[0]
      var setEditing = editingState[1]
      var draftState = React.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var openingState = React.useState(false)
      var opening = openingState[0]
      var setOpening = openingState[1]
      var messageState = React.useState('')
      var message = messageState[0]
      var setMessage = messageState[1]
      var errorState = React.useState('')
      var failure = errorState[0]
      var setFailure = errorState[1]

      // Re-read when the call settles: `preparing`/`start` run before the
      // server exists, `result` is the first phase where "running" can be true.
      var phase = props ? props.phase : undefined
      React.useEffect(function () {
        setMessage('')
        return readState(setStatus)
      }, [phase])

      var data = status.data
      var configured = data !== null && data.configured === true
      var running = data !== null && data.running === true
      var showForm = data !== null && (!configured || editing)

      function submit() {
        if (saving) return
        var key = draft.trim()
        if (key === '') {
          setFailure('请先输入 API Key')
          return
        }
        setSaving(true)
        setFailure('')
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ apiKey: key })
        })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + response.status)
              return body
            })
          })
          .then(function (body) {
            setSaving(false)
            setDraft('')
            setEditing(false)
            setStatus({ loading: false, data: body, error: null })
            setMessage('已保存到 DSH Credentials：' + (body.hint || 'API Key'))
          })
          .catch(function (error) {
            setSaving(false)
            setFailure(String((error && error.message) || error))
          })
      }

      function onKeyDown(event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      }

      /**
       * Open the running server in the system browser.
       *
       * Two rules learned from a card that appeared to do nothing:
       *
       * - Never `return` silently. A click with no address, no running server, or
       *   a stale card must say so; an inert button looks broken.
       * - Re-read the state first. The snapshot this card holds may predate the
       *   server becoming ready (the call's `result` phase can arrive before the
       *   first probe succeeds), and acting on that stale snapshot was exactly
       *   why the button did nothing.
       */
      function openBrowser() {
        if (opening) return
        setFailure('')
        setMessage('')
        setOpening(true)
        // The address this attempt learned, so the fallback below never reads a
        // stale render-time snapshot.
        var attemptUrl = null

        // Fresh state, not the render-time snapshot.
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (fresh) {
            setStatus({ loading: false, data: fresh, error: null })
            if (fresh.running !== true || !fresh.baseUrl) {
              throw new Error(
                fresh.starting === true
                  ? 'WeKnora 正在启动中（首次启动要建库和迁移），请稍候再试'
                  : 'WeKnora 还没有启动，请先调用一次 weknora_run'
              )
            }
            attemptUrl = fresh.baseUrl
            return fetch(OPEN_ROUTE, { method: 'POST', headers: { accept: 'application/json' } })
              .then(function (response) {
                return response.json().then(function (body) {
                  if (!response.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + response.status)
                  setOpening(false)
                  setMessage('已在系统浏览器打开：' + (body.url || fresh.baseUrl))
                })
              })
          })
          .catch(function (error) {
            setOpening(false)
            // The host route can be missing on an older host; a plain tab is next.
            // Only when a running address was actually confirmed: falling back on a
            // server that is not up would open a dead page and hide the real reason.
            if (attemptUrl !== null && typeof window !== 'undefined' && typeof window.open === 'function') {
              try {
                window.open(attemptUrl, '_blank', 'noopener')
                setMessage('已在浏览器标签页打开：' + attemptUrl)
                return
              } catch {
                /* fall through to the message */
              }
            }
            setFailure('无法打开浏览器：' + String((error && error.message) || error))
          })
      }

      var children = []
      children.push(
        h(
          'div',
          { style: rowStyle(), key: 'head' },
          h('strong', null, CARD_TITLE),
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'span',
              { style: mutedStyle() },
              running && data.port
                ? '运行中 · :' + data.port
                : running
                  ? '运行中'
                  // `data` is null until the first status read settles, and again
                  // if that read failed; every field access has to tolerate it or
                  // the whole card throws and renders nothing at all.
                  : status.loading || (data !== null && data.starting === true)
                    ? '启动中…'
                    : '未启动'
            ),
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle(false),
                onClick: openBrowser,
                disabled: opening,
                title: running
                  ? '用系统默认浏览器打开 WeKnora 页面'
                  : data !== null && data.starting === true
                    ? 'WeKnora 正在启动中，稍候即可打开'
                    : 'WeKnora 尚未启动：先调用一次 weknora_run，或稍等片刻'
              },
              opening ? '打开中…' : '在浏览器打开'
            )
          )
        )
      )

      if (data !== null && data.baseUrl) {
        children.push(
          h(
            'div',
            { style: { marginTop: 2 }, key: 'url' },
            h(
              'a',
              {
                href: data.baseUrl,
                target: '_blank',
                rel: 'noreferrer',
                style: { color: COLOR.accent, textDecoration: 'none' }
              },
              data.baseUrl
            )
          )
        )
      }

      if (status.loading) {
        children.push(h('div', { style: mutedStyle(), key: 'loading' }, '读取配置中…'))
      } else if (status.error !== null) {
        children.push(
          h(
            'div',
            { style: { color: COLOR.danger, marginTop: 6 }, key: 'unreachable' },
            '插件后端未就绪（' + status.error + '）。重启 DeepSeek Harness 后可用。'
          )
        )
      } else if (configured && !editing) {
        children.push(
          h(
            'div',
            { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }, key: 'configured' },
            h('span', null, 'API Key 已配置：'),
            h('code', { style: { font: '12px ui-monospace, Consolas, monospace' } }, data.hint || '****'),
            h(
              'button',
              { type: 'button', style: buttonStyle(false), onClick: function () { setEditing(true); setFailure(''); setMessage('') } },
              '更换'
            )
          )
        )
      }

      if (showForm) {
        children.push(
          h(
            'div',
            { style: { marginTop: 6 }, key: 'form' },
            h('div', { style: mutedStyle() }, '请输入 WeKnora API Key'),
            h('input', {
              type: 'text',
              value: draft,
              placeholder: 'sk-…',
              spellCheck: false,
              autoComplete: 'off',
              style: inputStyle(),
              onChange: function (event) {
                setDraft(event.target.value)
              },
              onKeyDown: onKeyDown,
              disabled: saving
            }),
            h(
              'div',
              { style: Object.assign({}, mutedStyle(), { marginTop: 4 }) },
              '在 WeKnora 页面 → 空间设置 → API Key 创建'
            ),
            h(
              'div',
              { style: Object.assign({}, mutedStyle(), { marginTop: 2 }) },
              '保存后本次 weknora_run 调用会继续（最多等 5 分钟）'
            ),
            h(
              'div',
              { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' } },
              h(
                'button',
                { type: 'button', style: buttonStyle(true), onClick: submit, disabled: saving },
                saving ? '保存中…' : '确定'
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle(false),
                  onClick: function () {
                    setEditing(false)
                    setDraft('')
                    setFailure('')
                  }
                },
                '取消'
              ),
              h('span', { style: mutedStyle() }, '保存到 DSH Credentials，不会写入 shell 配置或环境变量')
            )
          )
        )
      }

      if (message !== '') {
        children.push(h('div', { style: { marginTop: 6, color: COLOR.accent }, key: 'message' }, message))
      }
      if (failure !== '') {
        children.push(h('div', { style: { marginTop: 6, color: COLOR.danger }, key: 'failure' }, failure))
      }

      return h('div', { style: cardStyle() }, children)
    }

    function apply(ctx) {
      if (ctx === undefined || ctx.slots === undefined || typeof ctx.slots.inject !== 'function') return
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({ name: 'tool.call.toolview', key: 'weknora_run' }, WeknoraCard)
      })
    }

    // A client half is its own plugin, not a second face of the host plugin: the
    // loader keys plugin instances by name, and reusing the package name made the
    // host row and this row collide — the card then never mounted, while the tool
    // still ran. The name is derived from what this half contributes.
    exports.name = 'weknora-run-card'
    exports.inject = ['slots']
    exports.apply = apply
    exports.WeknoraCard = WeknoraCard
    return module.exports
  }
})