import { useEffect, useState } from 'react'
import { useGLTF } from '@react-three/drei'
import { Scene } from './Scene'
import { HUD } from './ui/HUD'
import { MenuOverlay } from './ui/MenuOverlay'
import { LoadingScreen } from './ui/LoadingScreen'
import { GameErrorBoundary } from './components/GameErrorBoundary'
import { useGameStore } from './stores/gameStore'
import { AudioManager, SOUND_PATHS } from './audio/AudioManager'
import { assetsChecked, assetUrl, checkAssets, hasAsset, MODEL_FILES } from './assets/availability'

/**
 * Finds out which asset files are there (assets/availability.ts) before the 3D scene mounts, so every part
 * knows whether to load its file or build its stand-in. The loading screen shows meanwhile.
 */
function useAssetCheck(): boolean {
  const [ready, setReady] = useState(assetsChecked())
  useEffect(() => {
    checkAssets(SOUND_PATHS).then(() => {
      // Start downloading the models that are there right away
      for (const f of Object.values(MODEL_FILES)) if (hasAsset(f)) useGLTF.preload(assetUrl(f))
      setReady(true)
    })
  }, [])
  return ready
}

/** Picks the music for the current screen and applies the volume settings. */
function MusicDirector() {
  const phase = useGameStore((s) => s.phase)
  const musicVolume = useGameStore((s) => s.musicVolume)
  const sfxVolume = useGameStore((s) => s.sfxVolume)
  const isMuted = useGameStore((s) => s.isMuted)

  useEffect(() => {
    AudioManager.getInstance().setVolumes(0.9, musicVolume, sfxVolume, isMuted)
  }, [musicVolume, sfxVolume, isMuted])

  useEffect(() => {
    const am = AudioManager.getInstance()
    const choose = () => am.playMusic(phase === 'driving' ? 'musicDrive' : phase === 'loading' ? null : 'musicMenu')
    choose()
    // Browsers only allow sound after a click or key press; try again then
    const retry = () => { am.resume().then(choose) }
    window.addEventListener('pointerdown', retry, { once: true })
    window.addEventListener('keydown', retry, { once: true })
    return () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
    }
  }, [phase])

  // Quiet everything when the tab is hidden
  useEffect(() => {
    const onVis = () => {
      const am = AudioManager.getInstance()
      if (document.hidden) am.context.suspend()
      else am.resume()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  return null
}

function App() {
  const assetsReady = useAssetCheck()
  return (
    <GameErrorBoundary>
      <div className="fixed inset-0 w-full h-full bg-black">
        {assetsReady && (
          <>
            <div className="absolute inset-0 w-full h-full">
              <Scene />
            </div>
            <div className="absolute inset-0 pointer-events-none">
              <HUD />
            </div>
            <MenuOverlay />
          </>
        )}
        <LoadingScreen />
        <MusicDirector />
      </div>
    </GameErrorBoundary>
  )
}

export default App
