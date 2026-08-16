import { describe, expect, it } from 'vitest'

import {
  decideRecovery,
  type RecoveryProbe,
  type RecoveryState,
} from '../../src/client/reconnect.js'

const waiting = (savedBootId = 'boot-a'): RecoveryState => ({
  phase: 'waiting',
  savedBootId,
})

const reloading = (savedBootId = 'boot-a'): RecoveryState => ({
  phase: 'reloading',
  savedBootId,
})

/** A healthy, bridge-ready probe that reports a fresh boot id. */
const healthyNew = (bootId = 'boot-b'): RecoveryProbe => ({
  healthy: true,
  bridgeReady: true,
  bootId,
})

describe('decideRecovery', () => {
  it('stays waiting while the host is unhealthy', () => {
    expect(decideRecovery(waiting(), {
      healthy: false,
      bridgeReady: false,
      bootId: undefined,
    })).toEqual({ type: 'stay' })
  })

  it('stays waiting while the bridge is absent even if health is ok', () => {
    expect(decideRecovery(waiting(), {
      healthy: true,
      bridgeReady: false,
      bootId: 'boot-b',
    })).toEqual({ type: 'stay' })
  })

  it('stays waiting while the boot id is unknown', () => {
    expect(decideRecovery(waiting(), {
      healthy: true,
      bridgeReady: true,
      bootId: undefined,
    })).toEqual({ type: 'stay' })
  })

  it('stays waiting while the bridge reports the same boot id', () => {
    expect(decideRecovery(waiting('boot-a'), {
      healthy: true,
      bridgeReady: true,
      bootId: 'boot-a',
    })).toEqual({ type: 'stay' })
  })

  it('requests a reload once a healthy new boot id is ready', () => {
    expect(decideRecovery(waiting(), healthyNew('boot-b'))).toEqual({
      type: 'reload',
      bootId: 'boot-b',
    })
  })

  it('once already reloading, a new boot id clears recovery instead of reloading again', () => {
    expect(decideRecovery(reloading(), healthyNew('boot-b'))).toEqual({
      type: 'clear',
    })
  })

  it('repeated identical healthy responses never trigger a second reload', () => {
    const first = decideRecovery(waiting(), healthyNew('boot-b'))
    expect(first).toEqual({ type: 'reload', bootId: 'boot-b' })

    // Progression: the reload decision moves the state into reloading.
    const afterReload = reloading('boot-b')
    // An identical probe while already reloading only clears — never a reload.
    expect(decideRecovery(afterReload, healthyNew('boot-b'))).toEqual({
      type: 'clear',
    })

    // And while still waiting, an identical (same-boot) response stays.
    expect(decideRecovery(waiting('boot-b'), healthyNew('boot-b'))).toEqual({
      type: 'stay',
    })
  })

  it('keeps waiting on an unhealthy probe even when the boot id changed', () => {
    expect(decideRecovery(waiting(), {
      healthy: false,
      bridgeReady: true,
      bootId: 'boot-b',
    })).toEqual({ type: 'stay' })
  })
})
