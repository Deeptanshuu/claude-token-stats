import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'token-stats',
  component: 'Pane',
  requestId: 'token-stats',
  props: {
    title: 'Token stats',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// Nothing sits beneath the plugin: these stand for the engine's own drawing,
// its clock (moved by hand) and the calls the mod makes on it.
const engine = (on: any) => {
  const clock = { now: 0 }
  on('clock.now', () => ({ value: clock.now }))
  on('command.register', () => ({ value: { command: 'token-stats' } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`${e.props.word}${e.props.suffix}`}</Text>
  })

  return clock
}

const usage = (output: number) => ({
  input_tokens: 100,
  output_tokens: output,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
  model: 'm',
})

const step = (agentId?: string) => ({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId })

// The row's cells: the five Texts after the header's `#`, newest row first.
const firstRow = async (ui: any) => {
  const texts: string[] = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  const at = texts.indexOf('#')

  return texts.slice(at + 5, at + 10)
}

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
  }
}

test('/token-stats toggles the panel, and takes open or close', async ($, on) => {
  engine(on)
  const calls: string[] = []
  on('ui.open', (_: any, e: any) => {
    calls.push(`open ${e.id}`)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: any, e: any) => {
    calls.push(`close ${e.id}`)

    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  const run = (args: string) =>
    $.command.run({ command: 'token-stats', args, origin: 'user', presentation: 'visible' } as any)

  // Opened on load; the command then closes it, opens it, and obeys its word.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((await run('')).text).toBe('Token stats panel closed.')
  expect((await run('')).text).toBe('Token stats panel opened.')
  expect((await run('open')).text).toBe('Token stats panel opened.')
  expect((await run(' Close ')).text).toBe('Token stats panel closed.')
  expect((await run('close')).text).toBe('Token stats panel closed.')
  expect(calls.filter(c => c.startsWith('open'))).toHaveLength(3)
  expect(calls.filter(c => c.startsWith('close'))).toHaveLength(3)
})

test('a finished turn becomes a row, and the session sums it', async ($, on) => {
  const clock = engine(on)
  on('turn.step', async function* () {
    // 400 chars over 1s, 80 real tokens, all of it seen; first piece at 1s.
    clock.now = 1000
    yield { kind: 'text', index: 0, text: 'x'.repeat(200) }
    clock.now = 2000
    yield { kind: 'text', index: 0, text: 'x'.repeat(200) }
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(80) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(80) }
  })
  await drain($.turn.step(step()))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await firstRow(ui)).toEqual(['1', '80', '1.0s', '90%', '80'])
    expect(await ui.find({ type: 'Text', text: /^90% hit$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^900$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^(Idle|Running tools) · 1 turn$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('withheld thinking is timed over the whole request', async ($, on) => {
  const clock = engine(on)
  on('turn.step', async function* () {
    // 2000 tokens, almost none visible, over 10s.
    clock.now = 9900
    yield { kind: 'text', index: 0, text: 'ok' }
    clock.now = 10000
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(2000) }
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(2000) }
  })
  await drain($.turn.step(step()))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await firstRow(ui))[1]).toBe('200')
  await ui.unmount()
})

test('a subagent step adds no row', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(50) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(50) }
  })
  await drain($.turn.step(step('a1')))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No turns yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nothing measured yet/ })).toBeDefined()
  await ui.unmount()
})

test('a reload with no surface attached opens no panel', async ($, on) => {
  on('command.register', () => ({ value: { command: 'token-stats' } }))
  let opens = 0
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.surfaces', () => ({ value: [] }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opens).toBe(0)
})

const BAND = {
  plugin: 'token-stats',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const inBand = { in: 'token-stats-band' }
// One whole line of the strip: its left side or its figures.
const line = async (ui: any, text: RegExp) => (await ui.find({ type: 'Text', text, ...inBand }))?.text as string | undefined
const LEFT = /Token stats/
const FIGURES = /tok\/s/

test('the strip shows the last turn, and a click opens the panel and hides it', async ($, on) => {
  const clock = engine(on)
  let opens = 0
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('turn.step', async function* () {
    // 80 tokens seen over 2s, the first piece at 1s.
    clock.now = 1000
    yield { kind: 'text', index: 0, text: 'x'.repeat(200) }
    clock.now = 3000
    yield { kind: 'text', index: 0, text: 'x'.repeat(200) }
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(80) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(80) }
  })

  let ui = await $.ui.mount(BAND)
  expect(await line(ui, LEFT)).toBe('Token stats')
  expect(await line(ui, /Waiting/)).toBe('Waiting for a turn')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()

  await drain($.turn.step(step()))
  ui = await $.ui.mount(BAND)
  expect(await line(ui, FIGURES)).toBe('40 tok/s  \u00B7  1.0s ttft  \u00B7  90% cached  \u00B7  80 out')

  await ui.pointer({ type: 'up', x: 9, y: 0, button: 'right', ...inBand })
  expect(opens).toBe(0)
  await ui.pointer({ type: 'up', x: 9, y: 0, button: 'left', ...inBand })
  expect(opens).toBe(1)
  await ui.unmount()

  // The panel open, the strip gives the band back.
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: LEFT })).toBeUndefined()
  await ui.unmount()

  // A survey holds the band too.
  const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await survey.find({ type: 'Text', text: LEFT })).toBeUndefined()
  await survey.unmount()
})

test('hovering shows a \u2715 that hides the strip, and /token-stats strip brings it back', async ($, on) => {
  engine(on)
  let opens = 0
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })

  let ui = await $.ui.mount(BAND)
  // The \u2715 comes after the label, so the label never moves.
  await ui.pointer({ type: 'enter', x: 0, y: 0, ...inBand })
  expect(await line(ui, LEFT)).toBe('Token stats  \u2715')
  await ui.pointer({ type: 'leave', x: 0, y: 0, ...inBand })
  expect(await line(ui, LEFT)).toBe('Token stats')

  await ui.pointer({ type: 'enter', x: 0, y: 0, ...inBand })
  await ui.pointer({ type: 'up', x: 13, y: 0, button: 'left', ...inBand })
  expect(opens).toBe(0)
  await ui.unmount()
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: LEFT })).toBeUndefined()
  await ui.unmount()

  const ran = await $.command.run({ command: 'token-stats', args: 'strip', origin: 'user', presentation: 'visible' } as any)
  expect(ran.text).toBe('Token stats strip shown.')
  ui = await $.ui.mount(BAND)
  expect(await line(ui, LEFT)).toBe('Token stats')
  await ui.unmount()
})

test('a reply that arrives in one burst is timed over the whole request', async ($, on) => {
  const clock = engine(on)
  on('turn.step', async function* () {
    // 240 tokens, all seen, but within 0.4s of a 4s request.
    clock.now = 3600
    yield { kind: 'text', index: 0, text: 'x'.repeat(960) }
    clock.now = 4000
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(240) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(240) }
  })
  await drain($.turn.step(step()))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await firstRow(ui))[1]).toBe('60')
  await ui.unmount()
})

test('/token-stats reset clears the turns and the session', async ($, on) => {
  engine(on)
  on('turn.step', async function* () {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(50) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(50) }
  })
  await drain($.turn.step(step()))

  const ran = await $.command.run({ command: 'token-stats', args: 'reset', origin: 'user', presentation: 'visible' } as any)
  expect(ran.text).toBe('Token stats cleared.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No turns yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No prompts yet/ })).toBeDefined()
  await ui.unmount()
})

test('while a reply streams the strip is live, its rate easing instead of jumping', async ($, on) => {
  const clock = engine(on)
  const seen: { left?: string; figures?: string }[] = []
  let ui: any

  on('turn.step', async function* () {
    // 30 chars every 100ms (100 tok/s at 3 chars a token), then 4x faster.
    for (let i = 1; i <= 20; i++) {
      clock.now = i * 100
      yield { kind: 'text', index: 0, text: 'x'.repeat(i <= 10 ? 30 : 120) }
      if (i === 8) seen.push({ left: await line(ui, LEFT), figures: await line(ui, FIGURES) })
      else if (i % 4 === 0) seen.push({ figures: await line(ui, FIGURES) })
    }
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(500) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(500) }
  })

  ui = await $.ui.mount(BAND)
  await drain($.turn.step(step()))

  expect(seen[1]!.left).toBe('Token stats \u00B7 live')
  expect(seen[0]!.figures).toMatch(/0\.1s ttft/)
  const rates = seen.map(s => Number(/^(\d+) tok/.exec(s.figures ?? '')?.[1]))
  // Sampled at 0.4s .. 2.0s; the speedup lands at 1.1s.
  for (let i = 1; i < rates.length; i++) expect(rates[i]!).toBeGreaterThanOrEqual(rates[i - 1]!)
  expect(rates[0]!).toBeLessThan(130)
  expect(rates[2]!).toBeLessThan(330)
  expect(rates.at(-1)!).toBeGreaterThan(rates[2]!)
  await ui.unmount()
})

test('thinking, which streams as a short summary, does not skew the speed', async ($, on) => {
  const clock = engine(on)
  // Summaries a little shorter each time: about 3 chars a token down to 0.6.
  const ratios = [3, 2.2, 1.6, 1.15, 0.85, 0.6]
  let call = 0
  let figures = ''
  let ui: any

  on('turn.step', async function* () {
    const at = call * 100_000
    const ratio = ratios[call++]
    if (ratio !== undefined) {
      for (let i = 1; i <= 10; i++) {
        clock.now = at + i * 1000
        yield { kind: 'thinking', index: 0, text: 'y'.repeat(ratio * 100) }
      }
      yield { kind: 'stop', stopReason: 'end_turn', usage: usage(1000) }
      return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(1000) }
    }
    // Then plain text at 100 tok/s, 3 chars a token.
    for (let i = 1; i <= 20; i++) {
      clock.now = at + i * 100
      yield { kind: 'text', index: 0, text: 'x'.repeat(30) }
    }
    figures = (await line(ui, FIGURES)) ?? ''
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(200) }
    return { turnId: 't', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: usage(200) }
  })

  ui = await $.ui.mount(BAND)
  for (let i = 0; i <= ratios.length; i++) await drain($.turn.step(step()))

  const rate = Number(/^(\d+) tok/.exec(figures)?.[1])
  expect(rate).toBeGreaterThan(60)
  expect(rate).toBeLessThan(160)
  await ui.unmount()
})
