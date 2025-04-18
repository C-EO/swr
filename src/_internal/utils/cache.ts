import { defaultConfigOptions } from './web-preset'
import { IS_SERVER } from './env'
import { UNDEFINED, mergeObjects, noop } from './shared'
import { internalMutate } from './mutate'
import { SWRGlobalState } from './global-state'
import * as revalidateEvents from '../events'

import type {
  Cache,
  ScopedMutator,
  RevalidateEvent,
  RevalidateCallback,
  ProviderConfiguration,
  GlobalState
} from '../types'

const revalidateAllKeys = (
  revalidators: Record<string, RevalidateCallback[]>,
  type: RevalidateEvent
) => {
  for (const key in revalidators) {
    if (revalidators[key][0]) revalidators[key][0](type)
  }
}

export const initCache = <Data = any>(
  provider: Cache<Data>,
  options?: Partial<ProviderConfiguration>
):
  | [Cache<Data>, ScopedMutator, () => void, () => void]
  | [Cache<Data>, ScopedMutator]
  | undefined => {
  // The global state for a specific provider will be used to deduplicate
  // requests and store listeners. As well as a mutate function that is bound to
  // the cache.

  // The provider's global state might be already initialized. Let's try to get the
  // global state associated with the provider first.
  if (!SWRGlobalState.has(provider)) {
    const opts = mergeObjects(defaultConfigOptions, options)

    // If there's no global state bound to the provider, create a new one with the
    // new mutate function.
    const EVENT_REVALIDATORS = Object.create(null)

    const mutate = internalMutate.bind(UNDEFINED, provider) as ScopedMutator
    let unmount = noop

    const subscriptions: Record<string, ((current: any, prev: any) => void)[]> =
      Object.create(null)
    const subscribe = (
      key: string,
      callback: (current: any, prev: any) => void
    ) => {
      const subs = subscriptions[key] || []
      subscriptions[key] = subs

      subs.push(callback)
      return () => subs.splice(subs.indexOf(callback), 1)
    }
    const setter = (key: string, value: any, prev: any) => {
      provider.set(key, value)
      const subs = subscriptions[key]
      if (subs) {
        for (const fn of subs) {
          fn(value, prev)
        }
      }
    }

    const initProvider = () => {
      if (!SWRGlobalState.has(provider)) {
        // Update the state if it's new, or if the provider has been extended.
        SWRGlobalState.set(provider, [
          EVENT_REVALIDATORS,
          Object.create(null),
          Object.create(null),
          Object.create(null),
          mutate,
          setter,
          subscribe
        ])
        if (!IS_SERVER) {
          // When listening to the native events for auto revalidations,
          // we intentionally put a delay (setTimeout) here to make sure they are
          // fired after immediate JavaScript executions, which can be
          // React's state updates.
          // This avoids some unnecessary revalidations such as
          // https://github.com/vercel/swr/issues/1680.
          const releaseFocus = opts.initFocus(
            setTimeout.bind(
              UNDEFINED,
              revalidateAllKeys.bind(
                UNDEFINED,
                EVENT_REVALIDATORS,
                revalidateEvents.FOCUS_EVENT
              )
            )
          )
          const releaseReconnect = opts.initReconnect(
            setTimeout.bind(
              UNDEFINED,
              revalidateAllKeys.bind(
                UNDEFINED,
                EVENT_REVALIDATORS,
                revalidateEvents.RECONNECT_EVENT
              )
            )
          )
          unmount = () => {
            releaseFocus && releaseFocus()
            releaseReconnect && releaseReconnect()
            // When un-mounting, we need to remove the cache provider from the state
            // storage too because it's a side-effect. Otherwise, when re-mounting we
            // will not re-register those event listeners.
            SWRGlobalState.delete(provider)
          }
        }
      }
    }
    initProvider()

    // This is a new provider, we need to initialize it and setup DOM events
    // listeners for `focus` and `reconnect` actions.

    // We might want to inject an extra layer on top of `provider` in the future,
    // such as key serialization, auto GC, etc.
    // For now, it's just a `Map` interface without any modifications.
    return [provider, mutate, initProvider, unmount]
  }

  return [provider, (SWRGlobalState.get(provider) as GlobalState)[4]]
}
