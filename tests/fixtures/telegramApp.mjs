import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { OsEventTypeList as os } from '@evenrealities/even_hub_sdk'

// Exercise the packaged app and real phone store on a fresh origin. The browser is
// offline and every HTTP request terminates in this fixture or is aborted.
export async function exerciseTelegramApp(browser, dist, recordings) {
  const origin = 'https://g2-app.invalid'
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block', viewport: { width: 412, height: 850 } })
  try {
    const question = { id: 'q2', sender: 'Ada', text: 'Which gift are you watching?', chatLabel: 'Gift group' }
    const state = { enabled: true, privateChat: { id: 'private', label: 'My chat' }, group: { id: 'group', label: 'Gift group' },
      candidate: null, questions: [question] }
    const posts = []
    const dailyBuckets = new Set()
    const mime = { js: 'text/javascript', css: 'text/css', html: 'text/html', png: 'image/png', wasm: 'application/wasm', json: 'application/json' }
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) {
        const file = url.pathname.slice(1) || 'index.html'
        try {
          const body = await readFile(new URL(file, dist))
          return route.fulfill({ body, contentType: mime[file.split('.').at(-1)] ?? 'application/octet-stream' })
        } catch { return route.abort() }
      }
      const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
      const json = data => route.fulfill({ headers, json: data })
      if (url.pathname === '/g2/telegram/state') return json(state)
      if (url.pathname === '/g2/telegram/send' && request.method() === 'POST') {
        posts.push(request.postDataJSON())
        return json({ status: 'sent' })
      }
      if (url.pathname.endsWith('/gifts/get_gifts_price_list')) return json({ collection_floors: { 'Toy Bear': { mrkt: 10 } } })
      if (url.pathname === '/history') {
        const interval = url.searchParams.get('resolution') === '15' ? 900 : 86400
        const start = Math.floor(Number(url.searchParams.get('to')) / interval) * interval - interval
        if (interval === 86400 && url.searchParams.get('name') === 'Toy Bear') dailyBuckets.add(start)
        return json({ s: 'ok', source: url.searchParams.get('source'), t: [start], o: [5], h: [7], l: [4], c: [6.5] })
      }
      if (request.resourceType() === 'fetch' || request.resourceType() === 'xhr') return json({})
      return route.abort()
    })
    await context.addInitScript(() => {
      localStorage.setItem('hasCompletedOnboarding', 'true')
      window.flutter_inappwebview = {}
      window.startedSends = 0
      const fetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : input
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        if (method === 'POST' && new URL(url, location.href).pathname === '/g2/telegram/send') window.startedSends++
        return fetch(input, init)
      }
      window.glassHistory = []
      window.refusedUploads = 0
      const show = page => {
        window.nativePage = page
        window.nativeBitmap = undefined
        window.glassHistory.push(page.textObject[0].content.split('\n').filter(Boolean).slice(0, 2).join(' · '))
      }
      const bridge = {
        ready: true,
        createStartUpPageContainer: async page => { show(page); return 0 },
        rebuildPageContainer: async page => { show(page); return true },
        textContainerUpgrade: async text => { window.nativePage.textObject[0].content = text.content; return true },
        updateImageRawData: async image => {
          const target = window.nativePage.imageObject?.find(container =>
            image.containerID === container.containerID && image.containerName === container.containerName)
          if (!target) throw new Error('Image upload does not match the current native image container')
          if (window.refuseImages) { window.refusedUploads++; return 'sendFailed' }
          window.nativeBitmap = new Uint8Array(image.imageData)
          return 'success'
        },
        audioControl: async () => true,
        onEvenHubEvent(callback) { window.nativeEvent = callback; return () => { window.nativeEvent = undefined } },
      }
      // The SDK normally installs the native host's singleton during module evaluation.
      Object.defineProperty(window, 'EvenAppBridge', { get: () => bridge, set() {} })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', msg => { if (msg.text().includes('G2 display')) errors.push(msg.text()) })
    page.setDefaultTimeout(8_000)
    await page.goto(origin)
    const waitText = async text => {
      try { await page.waitForFunction(s => window.nativePage?.textObject[0].content.includes(s), text) }
      catch (error) {
        const shown = await page.evaluate(() => [window.glassHistory.slice(-14), document.body.innerText.slice(0, 500)])
        throw new Error('Expected ' + text + ' on G2. Glasses and phone showed ' + JSON.stringify(shown) + ' ' + errors.join('\n'), { cause: error })
      }
    }
    const event = data => page.evaluate(e => window.nativeEvent(e), data)
    const tap = () => event({ textEvent: {} })
    const back = () => event({ sysEvent: { eventType: os.DOUBLE_CLICK_EVENT } })
    const menuID = label => page.evaluate(label => {
      const item = window.nativePage.menuObject?.menuItems.find(i => i.itemName === label)
      if (!item) throw new Error('Missing ' + label + ' in ' + window.nativePage.textObject[0].content)
      return item.itemID
    }, label)
    const choose = async label => {
      await event({ sysEvent: { eventType: os.FOREGROUND_ENTER_EVENT } })
      await event({ menuItemClickEvent: { itemID: await menuID(label) } })
      await event({ sysEvent: { eventType: os.FOREGROUND_EXIT_EVENT } })
    }
    const waitBitmap = () => page.waitForFunction(() => Boolean(window.nativeBitmap?.length))
    const waitChartSheet = () => page.locator('[role="dialog"][data-top-sheet="true"]:not(.is-closing) [role="slider"].gift-history-chart').waitFor()
    const speak = async (target, phone = false) => {
      if (phone) await page.locator('[role="dialog"][data-top-sheet="true"]').getByRole('button', { name: 'Voice command', exact: true }).click()
      else await choose('Voice command')
      await waitText('Listening…')
      await page.evaluate(async base64 => {
        const pcm = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
        for (let i = 0; i < pcm.length; i += 3200) {
          const packet = pcm.subarray(i, i + 3200)
          await new Promise(done => setTimeout(done, packet.length / 32))
          window.nativeEvent({ audioEvent: { source: 'glasses', speakerRole: 'self', audioPcm: packet } })
        }
      }, recordings.get(target).toString('base64'))
    }
    await waitText('Tap for details')
    await page.getByRole('button', { name: 'Questions (1)', exact: true }).click()
    await waitText(question.text)
    await tap()
    await waitText('Tap to use for reply')
    await page.getByRole('button', { name: 'Choose a chart to reply' }).click()
    await waitText('Tap for details')
    await page.waitForFunction(() => !document.body.classList.contains('sheet-open'))
    await tap()
    await waitText('Down for chart')
    await event({ sysEvent: { eventType: os.SCROLL_BOTTOM_EVENT } })
    await page.getByRole('radio', { name: '1w', exact: true }).click()
    await waitText('Collection floor · 7d UTC')
    await waitText('Last 6.5 GRAM')
    await waitBitmap()
    const chart = await page.evaluate(() => ({
      range: /Collection floor · (\S+) UTC/.exec(window.nativePage.textObject[0].content)[1],
      png: btoa(String.fromCharCode(...window.nativeBitmap)),
    }))
    await speak('private', true)
    await waitText('To My chat')
    await page.getByRole('button', { name: 'Send chart', exact: true }).waitFor()
    const stale = await menuID('Send')
    await back()
    await waitText('Last 6.5 GRAM')
    await waitChartSheet()
    await waitBitmap()
    assert.equal(posts.length, 0)
    await speak('reply')
    await waitText('To Gift group')
    const confirmation = await page.evaluate(() => window.nativePage.textObject[0].content)
    await event({ menuItemClickEvent: { itemID: stale } })
    await tap()
    assert.equal(posts.length, 0)
    assert.equal(await page.evaluate(() => window.startedSends), 0)
    const send = await menuID('Send')
    await event({ menuItemClickEvent: { itemID: send } })
    await event({ menuItemClickEvent: { itemID: send } })
    await waitText('Sent\nTo Gift group')
    assert.equal(await page.evaluate(() => window.startedSends), 1)
    assert.equal(posts.length, 1)
    const [post] = posts
    assert.deepEqual([post.destinationId, post.questionId, post.collection, post.range, post.last, post.pngBase64],
      [state.group.id, question.id, 'Toy Bear', chart.range, 6.5, chart.png])
    assert.ok(dailyBuckets.has(post.lastTime))
    assert.ok(confirmation.includes('Bucket ' + new Date(post.lastTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'))

    await back()
    await waitText('Collection floor · 7d UTC')
    await waitChartSheet()
    await waitBitmap()
    await choose('Send to my Telegram')
    await waitText('To My chat')
    await page.getByRole('button', { name: 'Send chart', exact: true }).click()
    await waitText('Sent\nTo My chat')
    assert.equal(posts.length, 2)
    const privatePost = posts[1]
    assert.deepEqual([privatePost.destinationId, privatePost.questionId, privatePost.collection, privatePost.range,
      privatePost.last, privatePost.lastTime, privatePost.pngBase64], [state.privateChat.id, null, 'Toy Bear', chart.range, 6.5, post.lastTime, chart.png])

    await back()
    await waitText('Collection floor · 7d UTC')
    await page.evaluate(() => { window.refuseImages = true })
    await page.getByRole('radio', { name: '1M', exact: true }).click()
    await waitText('Collection floor · 30d UTC')
    await page.waitForFunction(() => window.refusedUploads > 0)
    await speak('private')
    await waitText('Unavailable on this screen.')
    assert.ok(await page.evaluate(() => !window.nativePage.menuObject?.menuItems.some(i => i.itemName === 'Send')))
    assert.equal(posts.length, 2)
  } finally {
    await context.close()
  }
}
