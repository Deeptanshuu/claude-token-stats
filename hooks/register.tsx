import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Live, Turn } from '../types'
import type { StripProps } from './band-client.tsx'

const PANE = 'token-stats'
// The band strip's surface module instance: what its ui.message names.
const BAND_CLIENT = 'token-stats-band'

// Change a tag when its type's fields change: it declines what an earlier
// version stored, which outlives a reload.
const turns = atom({ plugin: 'token-stats', key: 'turns' } as const, [], {
  shape: 'turns-1',
})
const session = atom(
  { plugin: 'token-stats', key: 'session' } as const,
  { cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0 },
  { shape: 'session-2' },
)
// The turn running now; null between turns.
const live = atom({ plugin: 'token-stats', key: 'live' } as const, null, {
  shape: 'live-2',
})
const isPaneOpen = atom({ plugin: 'token-stats', key: 'isPaneOpen' } as const, false)
const isStripHidden = atom({ plugin: 'token-stats', key: 'isStripHidden' } as const, false)

const KEEP = 200
const PUBLISH_EVERY_MS = 100
const WINDOW_MS = 1500
// How far the shown rate moves toward the measured one per publish.
const EASE = 0.3
// The plausible range of chars per token for text and tool input.
const MIN_CHARS_PER_TOKEN = 1.5
const MAX_CHARS_PER_TOKEN = 6
// Shorter spans are mostly jitter, not a rate.
const MIN_SPAN_MS = 300
// A visible span shorter than this is a burst, not a rate.
const MIN_SEEN_MS = 1000
const DASH = '–'

// Claude's orange, and the two other segments of the cache bar.
const CLAUDE = '#D97757'
const READ = '#5BB98C'
const WRITE = CLAUDE
const UNCACHED = '#6E8EF0'
const TRACK = 'rgba(127,127,127,0.22)'

const tokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const percent = (x: number) => `${Math.round(x * 100)}%`

type Running = {
  output: number
  genMs: number
  prompt: number
  cacheRead: number
  ttftMs: number | null
}
type Mood = 'idle' | 'waiting' | 'streaming'

// Clawd, Claude Code's mascot, pixel for pixel from the terminal banner
//    ▐▛███▜▌
//   ▝▜█████▛▘
//     ▘▘ ▝▝
// each glyph two pixels wide and two tall: a head with two eye notches, arms
// out at the widest row, four short legs. Idle he breathes and blinks,
// waiting he glances about, streaming he hops and scuttles. The markup
// depends on the mood alone, so the speed redrawing never changes it.
// A banner pixel is half a terminal cell each way, and a cell is about
// twice as tall as wide: so each pixel is drawn twice as tall as wide.
const CLAWD_W = 48
const CLAWD_H = 37
// The same Clawd at a line's height, for the strip above the prompt.
const STRIP_CLAWD_W = 23
const STRIP_CLAWD_H = 18
const clawd = (mood: Mood) => {
  const px = (x: number, y: number, w = 1, h = 1, fill = CLAUDE) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
  const EYE = '#2A1A12'
  // CSS keyframes, which every frame the desktop draws an Svg in runs. Units
  // are the grid's own: a pixel is 1 across and (after the scale) 2 down.
  const style = {
    idle:
      '.b{animation:breathe 3.2s ease-in-out infinite}' +
      '.e{transform-box:fill-box;transform-origin:center;animation:blink 3.6s infinite}' +
      '@keyframes breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-.22px)}}' +
      '@keyframes blink{0%,90%,100%{transform:scaleY(1)}94%{transform:scaleY(.12)}}',
    waiting:
      '.b{animation:breathe 2.4s ease-in-out infinite}' +
      '.e{animation:glance 2.4s ease-in-out infinite}' +
      '@keyframes breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-.22px)}}' +
      '@keyframes glance{0%,12%,88%,100%{transform:translateX(0)}25%,45%{transform:translateX(-.5px)}60%,80%{transform:translateX(.5px)}}',
    streaming:
      '.b{animation:hop .46s ease-in-out infinite}' +
      '.l1{animation:step .3s ease-in-out infinite}' +
      '.l2{animation:step .3s ease-in-out -.15s infinite}' +
      '@keyframes hop{0%,100%{transform:translateY(0)}50%{transform:translateY(-.35px)}}' +
      '@keyframes step{0%,100%{transform:translateY(0)}50%{transform:translateY(-.45px)}}',
  }[mood]
  // Head (rows 0-1), arms (row 2), body (row 3), and two eye notches.
  const body = px(3, 0, 12, 2) + px(1, 2, 16, 1) + px(3, 3, 12, 1)
  const eyes = `<g class="e">${px(5, 1, 1, 1, EYE)}${px(12, 1, 1, 1, EYE)}</g>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -2 18 14" width="${CLAWD_W}" height="${CLAWD_H}" shape-rendering="crispEdges">` +
    `<style>${style}</style>` +
    `<g transform="scale(1 2)">` +
    `<g class="b">${body}${eyes}</g>` +
    `<g class="l1">${px(4, 4)}${px(11, 4)}</g>` +
    `<g class="l2">${px(6, 4)}${px(13, 4)}</g>` +
    `</g></svg>`
  )
}

// A short bar of one turn's speed against the session's peak.
const speedBar = (share: number, isLatest: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4" width="100%" height="4" preserveAspectRatio="none">` +
  `<rect x="0" y="0" width="100" height="4" rx="2" fill="${TRACK}"/>` +
  `<rect x="0" y="0" width="${Math.max(3, share * 100).toFixed(1)}" height="4" rx="2" fill="${CLAUDE}" fill-opacity="${isLatest ? 1 : 0.55}"/>` +
  `</svg>`

// Output tok/s across recent turns: a line over a soft fill, the latest
// marked, and a hover column per turn that names it.
const sparkline = (rows: Turn[]) => {
  const W = 300
  const H = 56
  const top = 6
  const max = Math.max(...rows.map(t => t.tps), 1)
  const x = (i: number) => (rows.length === 1 ? W / 2 : (i * W) / (rows.length - 1))
  const y = (v: number) => H - 2 - (v / max) * (H - 2 - top)
  const points = rows.map((t, i) => `${x(i).toFixed(1)},${y(t.tps).toFixed(1)}`)
  const line = `M${points.join(' L')}`
  const area = `${line} L${x(rows.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`
  const step = rows.length > 1 ? W / (rows.length - 1) : W
  const columns = rows
    .map(
      (t, i) =>
        `<rect class="col" x="${(x(i) - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}">` +
        `<title>Turn ${t.n} · ${t.tps.toFixed(0)} tok/s</title></rect>`,
    )
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">` +
    `<style>.col{fill:transparent}.col:hover{fill:rgba(217,119,87,0.12)}</style>` +
    `<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${CLAUDE}" stop-opacity="0.28"/><stop offset="1" stop-color="${CLAUDE}" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="${TRACK}" vector-effect="non-scaling-stroke"/>` +
    (rows.length > 1 ? `<path d="${area}" fill="url(#f)"/>` : '') +
    `<path d="${line}" fill="none" stroke="${CLAUDE}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    columns +
    `</svg>`
  )
}

// The cache's share of every prompt token: read, written, neither.
const cacheBar = (parts: { value: number; color: string }[]) => {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  const gap = 0.6
  const shown = parts.filter(p => p.value > 0)
  let at = 0
  const rects = shown
    .map((p, i) => {
      const w = Math.max(0.8, (p.value / total) * (100 - gap * (shown.length - 1)))
      const rect = `<rect x="${at.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="4" fill="${p.color}"/>`
      at += w + (i < shown.length - 1 ? gap : 0)

      return rect
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4" width="100%" height="5" preserveAspectRatio="none">` +
    `<rect x="0" y="0" width="100" height="4" fill="${TRACK}"/>${rects}</svg>`
  )
}

const moodOf = (now: Live | null): Mood =>
  now === null ? 'idle' : now.phase === 'streaming' ? 'streaming' : 'waiting'

const openPane = async ($: EngineInterface) => {
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'Token stats' })
  await update($, isPaneOpen, () => isPlaced)
}
const closePane = async ($: EngineInterface) => {
  await $.ui.close({ id: PANE })
  await update($, isPaneOpen, () => false)
}
const togglePane = async ($: EngineInterface) =>
  (await read($, isPaneOpen)) ? closePane($) : openPane($)

export const register: Register = on => {
  // Characters of streamed text or tool input per output token: seeded near
  // what recent models write, then learned from steps with no thinking, as a
  // thinking block streams only as a summary, often under 1 char a token.
  let charsPerToken = 3
  // The main thread's turns in flight, summed step by step.
  const running = new Map<string, Running>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-stats',
      description: 'Toggle the token stats panel (or: open, close, strip, reset)',
      argumentHint: '[open|close|strip|reset]',
    })
    // Opened beside the chat where a surface is attached; a reload with none
    // (or a surface that refuses) leaves it to /token-stats, quietly.
    if ((await $.session.surfaces()).length > 0) {
      openPane($).catch(() => {})
    }

    return next(e)
  })

  // Toggles the panel; `open` or `close` says which.
  on('command.run', { command: 'token-stats' }, async ($, e) => {
    const ask = e.args.trim().toLowerCase()
    if (ask === 'strip') {
      const hidden = await update($, isStripHidden, was => !was)

      return { text: hidden ? 'Token stats strip hidden.' : 'Token stats strip shown.' }
    }
    if (ask === 'reset') {
      await update($, turns, () => [])
      await update($, session, () => ({ cacheRead: 0, cacheWrite: 0, uncached: 0, output: 0 }))

      return { text: 'Token stats cleared.' }
    }
    const isOpen = await read($, isPaneOpen)
    if (ask === 'close' || (ask !== 'open' && isOpen)) {
      await closePane($)

      return { text: 'Token stats panel closed.' }
    }
    await openPane($)

    return { text: 'Token stats panel opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      await update($, isPaneOpen, () => false)
    }

    return closed
  })

  // A status strip across the band above the prompt while the panel is
  // closed: Clawd and "Token stats" at the left, the turn's figures at the right, live
  // while a reply streams. A surface module draws it as plain text and takes
  // the pointer, so a click opens the panel with no button chrome (the desktop
  // draws a plugin's Button with chrome of its own, and no Client in the
  // footer). It yields to a survey and keeps whatever the band held.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ui = $.ui.resolve(e)
    if (e.props.hasSurvey || !('Client' in ui) || (await read($, isPaneOpen)) || (await read($, isStripHidden))) {
      return next(e)
    }

    const below = await next(e)
    const now = await read($, live)
    const last = (await read($, turns)).at(-1)
    const props: StripProps =
      now !== null && now.phase === 'streaming'
        ? {
            isLive: true,
            tps: now.tps,
            ttft: now.ttftMs === null ? null : seconds(now.ttftMs),
            cache: null,
            out: tokens(now.output),
          }
        : last
          ? {
              isLive: false,
              tps: last.tps > 0 ? last.tps : null,
              ttft: last.ttftMs === null ? null : seconds(last.ttftMs),
              cache: percent(last.hit),
              out: tokens(last.output),
            }
          : { isLive: false, tps: null, ttft: null, cache: null, out: null }
    const { Box } = ui
    // Clawd, at the strip's left edge and the line's height, in the mood of
    // the turn; the desktop draws vector art, the terminal does without.
    const mascot =
      'Svg' in ui ? (
        <Box key="clawd" flexShrink={0}>
          <ui.Svg source={clawd(moodOf(now))} alt="Clawd" width={STRIP_CLAWD_W} height={STRIP_CLAWD_H} isInteractive />
        </Box>
      ) : null

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {mascot}
          <ui.Client key={BAND_CLIENT} module="./band-client.tsx" props={props} flexGrow={1} />
        </Box>
      </Box>
    )
  })

  // A click on the strip toggles the panel; one on its ✕ hides the strip.
  on('ui.message', async ($, e, next) => {
    if (e.element !== BAND_CLIENT) {
      return next(e)
    }
    const data = e.data as { hide?: true; toggle?: true }
    if (data.hide) {
      await update($, isStripHidden, () => true)
    } else {
      await togglePane($)
    }

    return {}
  })

  // Main thread only: subagents stream alongside it and would blur the rate.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    const turn = running.get(e.turnId) ?? { output: 0, genMs: 0, prompt: 0, cacheRead: 0, ttftMs: null }
    running.set(e.turnId, turn)
    await update($, live, was =>
      e.index === 0 || was === null
        ? { phase: 'waiting' as const, tps: null, ttftMs: null, output: 0 }
        : { ...was, phase: 'waiting' as const, ttftMs: null, output: turn.output },
    )

    const sentAt = await $.clock.now()
    let firstAt = 0
    let publishedAt = 0
    let chars = 0
    let hasThinking = false
    let textAt = 0
    let genMs = 0
    // Recent pieces, for a rate over the last WINDOW_MS rather than the whole
    // reply, eased into `shown` so the counter glides instead of jumping.
    const recent: { at: number; chars: number }[] = []
    let shown = 0
    const stream = next(e)

    for await (const chunk of stream) {
      if (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'input') {
        const now = await $.clock.now()
        if (!firstAt) {
          firstAt = now
          turn.ttftMs ??= now - sentAt
          await update($, live, was => was && { ...was, phase: 'streaming' as const, ttftMs: now - sentAt })
        }

        // A thinking summary's length says little about the tokens behind it,
        // so only text and tool input go toward the rate.
        if (chunk.kind === 'thinking') {
          hasThinking = true
          yield chunk
          continue
        }
        textAt ||= now
        const size = chunk.kind === 'input' ? chunk.json.length : chunk.text.length
        chars += size
        recent.push({ at: now, chars: size })
        while (recent.length > 1 && now - recent[0]!.at > WINDOW_MS) recent.shift()

        const span = now - recent[0]!.at
        if (now - textAt >= MIN_SPAN_MS && span > 0 && now - publishedAt >= PUBLISH_EVERY_MS) {
          const windowChars = recent.reduce((sum, r) => sum + r.chars, 0) - recent[0]!.chars
          const rate = windowChars / charsPerToken / (span / 1000)
          shown = shown === 0 ? rate : shown + (rate - shown) * EASE
          publishedAt = now
          const tps = Math.round(shown)
          const output = turn.output + Math.round(chars / charsPerToken)
          await update($, live, was => was && { ...was, tps, output })
        }
      }

      if (chunk.kind === 'stop') {
        const now = await $.clock.now()
        const out = chunk.usage?.output_tokens ?? 0
        // Thinking is counted in output_tokens but streams only as a summary,
        // if at all, and a short reply can arrive in one burst: either way the
        // visible span would overstate the rate, so then the whole request
        // is timed instead.
        const isMostlySeen = firstAt > 0 && chars / charsPerToken >= out * 0.7
        const seenMs = now - firstAt
        genMs = isMostlySeen && seenMs >= MIN_SEEN_MS ? seenMs : now - sentAt
        if (!hasThinking && out > 0 && chars > 0) {
          const ratio = Math.min(Math.max(chars / out, MIN_CHARS_PER_TOKEN), MAX_CHARS_PER_TOKEN)
          charsPerToken += (ratio - charsPerToken) * EASE
        }
      }

      yield chunk
    }

    const result = await stream.result
    const u = result.usage
    if (u) {
      turn.output += u.output_tokens
      turn.genMs += genMs
      turn.prompt += u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      turn.cacheRead += u.cache_read_input_tokens
      await update($, live, was => was && { ...was, phase: 'tools' as const, output: turn.output })
      await update($, session, s => ({
        cacheRead: s.cacheRead + u.cache_read_input_tokens,
        cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
        uncached: s.uncached + u.input_tokens,
        output: s.output + u.output_tokens,
      }))
    }

    // A step that asks for no tool ends the turn.
    if (result.stopReason !== 'tool_use') {
      running.delete(e.turnId)
      if (turn.output > 0) {
        await update($, turns, list => {
          const row: Turn = {
            n: (list.at(-1)?.n ?? 0) + 1,
            tps: turn.genMs >= MIN_SPAN_MS ? turn.output / (turn.genMs / 1000) : 0,
            ttftMs: turn.ttftMs,
            hit: turn.prompt > 0 ? turn.cacheRead / turn.prompt : 0,
            output: turn.output,
          }

          return [...list, row].slice(-KEEP)
        })
      }
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await update($, live, () => null)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const now = await read($, live)
    const list = await read($, turns)
    const total = await read($, session)
    const mood = moodOf(now)
    const prompt = total.cacheRead + total.cacheWrite + total.uncached
    const rated = list.filter(t => t.tps > 0)
    const avg = rated.length > 0 ? rated.reduce((sum, t) => sum + t.tps, 0) / rated.length : 0
    const peak = Math.max(0, ...rated.map(t => t.tps))
    const last = list.at(-1)
    // The desktop draws vector art; any other surface gets its text.
    const art = (source: string, alt: string, height: number, isInteractive?: true, width?: number) =>
      'Svg' in ui ? (
        <ui.Svg source={source} alt={alt} width={width} height={height} isInteractive={isInteractive} />
      ) : null

    const card = (title: string, aside: string | null, body: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text size="footnote" weight="medium">
            {title}
          </Text>
          {aside !== null && (
            <Text dimColor size="footnote" tabular>
              {aside}
            </Text>
          )}
        </Box>
        {body}
      </Box>
    )
    const figure = (value: string, label: string) => (
      <Text size="footnote">
        <Text tabular weight="medium">
          {value}
        </Text>
        <Text dimColor> {label}</Text>
      </Text>
    )
    const big = (value: string, label: string) => (
      <Box flexDirection="row" alignItems="flex-end" columnGap={1}>
        <Text size="title" weight="semibold" tabular>
          {value}
        </Text>
        <Text dimColor size="footnote">
          {label}
        </Text>
      </Box>
    )

    // Now: the reply streaming, else the last turn.
    const status =
      now === null
        ? 'Idle'
        : { waiting: 'Waiting for the first token', streaming: 'Streaming', tools: 'Running tools' }[now.phase]
    const shownTps = now?.tps ?? (now === null ? last?.tps : null)
    const shownTtft = now ? now.ttftMs : (last?.ttftMs ?? null)
    const shownOut = now ? now.output : (last?.output ?? 0)
    const nowCard = card(
      now ? 'Now' : 'Last turn',
      now ? null : last ? `#${last.n}` : null,
      now === null && last === undefined ? (
        <Text dimColor size="footnote">
          Nothing measured yet. Send a message.
        </Text>
      ) : (
        <Box flexDirection="row" alignItems="flex-end" justifyContent="space-between">
          {big(shownTps ? shownTps.toFixed(0) : DASH, 'tok/s')}
          <Box flexDirection="row" columnGap={2}>
            {figure(shownTtft === null ? DASH : seconds(shownTtft), 'ttft')}
            {figure(tokens(shownOut), 'out')}
          </Box>
        </Box>
      ),
    )

    const recent = rated.slice(-30)
    const speedCard = card(
      'Speed',
      rated.length > 0 ? `avg ${avg.toFixed(0)} · peak ${peak.toFixed(0)}` : null,
      recent.length < 2 ? (
        <Text dimColor size="footnote">
          The trend shows after two turns.
        </Text>
      ) : (
        art(sparkline(recent), `Output tokens per second over the last ${recent.length} turns`, 56, true) ?? (
          <Text dimColor size="footnote">
            {recent.map(t => t.tps.toFixed(0)).join(' · ')}
          </Text>
        )
      ),
    )

    const parts = [
      { label: 'Read', value: total.cacheRead, color: READ },
      { label: 'Written', value: total.cacheWrite, color: WRITE },
      { label: 'Uncached', value: total.uncached, color: UNCACHED },
    ]
    const cacheCard = card(
      'Cache',
      prompt > 0 ? `${percent(total.cacheRead / prompt)} hit` : null,
      prompt === 0 ? (
        <Text dimColor size="footnote">
          {list.length > 0 ? 'Fills in from your next message.' : 'No prompts yet.'}
        </Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          {art(cacheBar(parts), `Cache: ${percent(total.cacheRead / prompt)} of prompt tokens read`, 5)}
          <Box flexDirection="column">
            {parts.map(p => (
              <Box key={`cache-${p.label}`} flexDirection="row" columnGap={1}>
                <Text color={p.color} size="footnote">
                  {'■'}
                </Text>
                <Box flexGrow={1}>
                  <Text size="footnote">{p.label}</Text>
                </Box>
                <Box width={8} justifyContent="flex-end">
                  <Text dimColor size="footnote" tabular>
                    {tokens(p.value)}
                  </Text>
                </Box>
                <Box width={6} justifyContent="flex-end">
                  <Text size="footnote" tabular>
                    {percent(p.value / prompt)}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor size="footnote">
              Output
            </Text>
            <Text size="footnote" tabular>
              {tokens(total.output)}
            </Text>
          </Box>
        </Box>
      ),
    )

    // #, tok/s and its bar, ttft, cache, out. The bar takes what is left.
    type CellStyle = { dim?: boolean; color?: string; isLatest?: boolean; isHeader?: boolean }
    const cell = (text: string, width: number, style: CellStyle) => (
      <Box width={width} flexShrink={0} justifyContent={width === 4 ? 'flex-start' : 'flex-end'}>
        <Text
          dimColor={style.dim}
          color={style.color}
          size={style.isHeader ? 'caption' : 'footnote'}
          weight={style.isLatest ? 'semibold' : 'regular'}
          tabular
        >
          {text}
        </Text>
      </Box>
    )
    const healthOf = (hit: number) => (hit >= 0.9 ? READ : hit < 0.5 ? CLAUDE : undefined)
    const header = (
      <Box flexDirection="row" paddingX={1}>
        {cell('#', 4, { dim: true, isHeader: true })}
        {cell('tok/s', 6, { dim: true, isHeader: true })}
        <Box flexGrow={1} />
        {cell('ttft', 6, { dim: true, isHeader: true })}
        {cell('cache', 6, { dim: true, isHeader: true })}
        {cell('out', 7, { dim: true, isHeader: true })}
      </Box>
    )
    const row = (t: Turn, isLatest: boolean) => (
      <Box
        key={`turn-${t.n}`}
        flexDirection="row"
        alignItems="center"
        paddingX={1}
        backgroundColor={isLatest ? 'rgba(217,119,87,0.10)' : undefined}
      >
        {cell(`${t.n}`, 4, { dim: true })}
        {cell(t.tps > 0 ? t.tps.toFixed(0) : DASH, 6, { isLatest })}
        <Box flexGrow={1} paddingX={1} alignItems="center">
          {t.tps > 0 && peak > 0
            ? art(speedBar(t.tps / peak, isLatest), `${t.tps.toFixed(0)} of a ${peak.toFixed(0)} tok/s peak`, 4)
            : null}
        </Box>
        {cell(t.ttftMs === null ? DASH : seconds(t.ttftMs), 6, { isLatest })}
        {cell(percent(t.hit), 6, { color: healthOf(t.hit), isLatest })}
        {cell(tokens(t.output), 7, { isLatest })}
      </Box>
    )
    const room = Math.max(3, (e.props.scroll.bodyRows ?? 40) - 30)
    const turnsCard = card(
      'Turns',
      list.length > 0 ? `${list.length}` : null,
      list.length === 0 ? (
        <Text dimColor size="footnote">
          No turns yet
        </Text>
      ) : (
        <Box flexDirection="column">
          {header}
          {list
            .slice(-room)
            .reverse()
            .map((t, i) => row(t, i === 0))}
        </Box>
      ),
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" alignItems="center" columnGap={2} paddingX={1}>
          <Box flexShrink={0}>
            {art(clawd(mood), `Clawd, ${status.toLowerCase()}`, CLAWD_H, true, CLAWD_W) ?? (
              <Text color={CLAUDE}>{'\u273B'}</Text>
            )}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            <Text weight="semibold">Token stats</Text>
            <Text dimColor size="footnote">
              {status}
              {list.length > 0 ? ` · ${list.length} ${list.length === 1 ? 'turn' : 'turns'}` : ''}
            </Text>
          </Box>
        </Box>
        {nowCard}
        {speedCard}
        {cacheCard}
        {turnsCard}
        <Box paddingX={1}>
          <Text dimColor size="caption">
            Main conversation only; subagents are left out. Speed counts output tokens, hidden thinking included.
          </Text>
        </Box>
      </Box>
    )
  })
}
