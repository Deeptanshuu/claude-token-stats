// The band's status strip, as a surface module: plain text across the band,
// "Token stats" at the left (Clawd sits just before it, drawn by the hooks
// module) and the turn's figures at the right (each figure at full strength,
// its unit dim, as the model picker draws "Opus 5.5 High"). Each side is one
// line of text, so its spacing is the font's own. It takes the pointer itself,
// so there is no button chrome: while hovered a ✕ shows after the label,
// which hides the strip, and a left click anywhere else posts `{ toggle }` to
// the hooks module, which opens the panel.
import type { ClientModule, ClientSurface } from 'claude-code'

export type StripProps = {
  /** Live while a reply streams; else the last turn's. */
  isLive: boolean
  tps: number | null
  ttft: string | null
  cache: string | null
  out: string | null
}
type State = { isHovered: boolean }

// The ✕ shows after the label while hovered, so its coming and going moves
// nothing; a click within a column of it hides the strip.
const LABEL = 'Token stats'
const LIVE = ' · live'
const CLOSE_GAP = '  '
const CLOSE_SLACK = 1

// Instances whose pointer is wired, and the column each one's ✕ sits at as
// last drawn; the surface object is the same for every call of one instance.
const wired = new WeakSet<object>()
const closeAt = new WeakMap<object, number>()

function wire(surface: ClientSurface<State>) {
  wired.add(surface)
  surface.onPointer(e => {
    if (e.type === 'enter' || e.type === 'leave') {
      surface.setState({ isHovered: e.type === 'enter' })
    } else if (e.type === 'up' && (e.button ?? 'left') === 'left') {
      const at = closeAt.get(surface) ?? -10
      const isOnClose = e.x >= at - CLOSE_SLACK && e.x <= at + CLOSE_SLACK
      surface.post(isOnClose ? { hide: true } : { toggle: true })
    }
  })
}

const Strip: ClientModule<StripProps, State> = (props, surface) => {
  if (!wired.has(surface)) wire(surface)
  const { Box, Text } = surface.elements
  const isHovered = surface.state?.isHovered ?? false
  closeAt.set(surface, LABEL.length + (props.isLive ? LIVE.length : 0) + CLOSE_GAP.length)
  const figures = [
    props.tps === null ? null : [props.tps.toFixed(0), 'tok/s'],
    props.ttft === null ? null : [props.ttft, 'ttft'],
    props.cache === null ? null : [props.cache, 'cached'],
    props.out === null ? null : [props.out, 'out'],
  ].filter((f): f is string[] => f !== null)

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text dimColor={!isHovered}>{LABEL}</Text>
        {props.isLive ? <Text dimColor>{LIVE}</Text> : null}
        {isHovered ? <Text dimColor>{`${CLOSE_GAP}\u2715`}</Text> : null}
      </Text>
      {figures.length === 0 ? (
        <Text dimColor>{isHovered ? 'Open the panel' : 'Waiting for a turn'}</Text>
      ) : (
        <Text tabular>
          {figures.map(([value, unit], i) => (
            <Text>
              {i > 0 ? <Text dimColor>{'  ·  '}</Text> : null}
              {value}
              <Text dimColor>{` ${unit}`}</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  )
}

export default Strip
