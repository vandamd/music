import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useCallback } from 'react'
import type {
  CurrentTrack,
  LastFmResponse,
  AppleArtworkResponse,
  AppleAnimatedResponse,
  AlbumArtResult,
} from '../types/lastfm'

const getCurrentTrack = createServerFn({ method: 'GET' })
  .inputValidator((data: string) => data)
  .handler(async ({ data }): Promise<CurrentTrack> => {
    const username = data
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LAST_FM_API_KEY}&format=json&limit=1`
    const response = await fetch(url)

    if (!response.ok) {
      return null
    }

    const text = await response.text()
    if (!text) {
      return null
    }

    const apiData = JSON.parse(text) as LastFmResponse

    if (apiData.error) {
      return null
    }

    const tracks = apiData.recenttracks.track
    const trackData = Array.isArray(tracks) ? tracks[0] : tracks

    if (!trackData) {
      return null
    }

    const isPlaying = trackData['@attr']?.nowplaying === 'true'

    return {
      track: trackData.name,
      artist: trackData.artist['#text'],
      album: trackData.album['#text'],
      isPlaying,
    }
  })

async function fetchArtworkFromAppleMusicUrl(appleMusicUrl: string): Promise<AlbumArtResult | null> {
  const [artworkResponse, animatedResponse] = await Promise.all([
    fetch('https://clients.dodoapps.io/playlist-precis/playlist-artwork.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(appleMusicUrl)}`,
    }),
    fetch('https://clients.dodoapps.io/playlist-precis/playlist-artwork.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `url=${encodeURIComponent(appleMusicUrl)}&animation=true`,
    }),
  ])

  if (!artworkResponse.ok) return null

  const artworkText = await artworkResponse.text()
  if (!artworkText) return null

  const artworkData = JSON.parse(artworkText) as AppleArtworkResponse

  if (artworkData.error || !artworkData.large) return null

  let animatedUrl: string | null = null
  if (animatedResponse.ok) {
    const animatedText = await animatedResponse.text()
    if (animatedText) {
      const animatedData = JSON.parse(animatedText) as AppleAnimatedResponse
      animatedUrl = animatedData.animatedUrl?.includes('2160x2160')
        ? animatedData.animatedUrl
        : null
    }
  }

  return {
    imageUrl: artworkData.large,
    animatedUrl,
  }
}

const getAlbumArt = createServerFn({ method: 'GET' })
  .inputValidator((data: { artist: string; album: string; track: string }) => data)
  .handler(async ({ data }): Promise<AlbumArtResult | null> => {
    const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(`${data.artist} ${data.album}`)}&entity=album&limit=1`
    const searchResponse = await fetch(searchUrl)

    if (searchResponse.ok) {
      const searchText = await searchResponse.text()
      if (searchText) {
        const searchData = JSON.parse(searchText) as { results: Array<{ collectionViewUrl: string }> }

        if (searchData.results?.length) {
          const appleMusicUrl = searchData.results[0].collectionViewUrl
          if (appleMusicUrl) {
            const result = await fetchArtworkFromAppleMusicUrl(appleMusicUrl)
            if (result) return result
          }
        }
      }
    }

    const fallbackResponse = await fetch('https://artwork.dodoapps.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: `${data.artist} ${data.album}`, storefront: 'us', type: 'album' }),
    })

    if (!fallbackResponse.ok) return null

    const fallbackText = await fallbackResponse.text()
    if (!fallbackText) return null

    const fallbackData = JSON.parse(fallbackText) as { images?: Array<{ large: string }> }

    if (!fallbackData.images?.length) return null

    return {
      imageUrl: fallbackData.images[0].large,
      animatedUrl: null,
    }
  })

export const Route = createFileRoute('/$username')({
  component: UserListening,
  validateSearch: (search: Record<string, unknown>) => ({
    placeholder: typeof search.placeholder === 'string' ? search.placeholder : undefined,
  }),
  loader: async ({ params }) =>
    await getCurrentTrack({ data: params.username }),
})

type MediaSource = {
  type: 'video' | 'image'
  element: HTMLVideoElement | HTMLImageElement
  url: string
}

const TRANSITION_DURATION = 1500

function UserListening() {
  const { username } = Route.useParams()
  const { placeholder } = Route.useSearch()
  const initialData = Route.useLoaderData()

  const queryClient = useQueryClient()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const currentSourceRef = useRef<MediaSource | null>(null)
  const nextSourceRef = useRef<MediaSource | null>(null)
  const isTransitioningRef = useRef(false)
  const transitionStartTimeRef = useRef(0)
  const animationFrameRef = useRef<number>(0)
  const currentUrlRef = useRef<string | null>(null)

  const { data: currentTrack } = useQuery({
    queryKey: ['currentTrack', username],
    queryFn: () => getCurrentTrack({ data: username }),
    initialData,
    refetchInterval: (query) => {
      if (!query.state.data?.isPlaying) return 30000
      return 5000
    },
    refetchIntervalInBackground: false,
  })

  const { data: albumArt, isFetching: albumArtFetching } = useQuery({
    queryKey: ['albumArt', currentTrack?.artist, currentTrack?.album],
    queryFn: () =>
      getAlbumArt({ data: { artist: currentTrack!.artist, album: currentTrack!.album, track: currentTrack!.track } }),
    enabled: !!currentTrack?.artist && !!currentTrack?.album,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        queryClient.cancelQueries({ queryKey: ['currentTrack'] })
      } else {
        queryClient.invalidateQueries({ queryKey: ['currentTrack'] })
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [queryClient])

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height

    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, width, height)

    const drawCover = (source: MediaSource, alpha: number, blur: number = 0) => {
      const element = source.element
      let srcWidth: number
      let srcHeight: number

      if (source.type === 'video') {
        const video = element as HTMLVideoElement
        srcWidth = video.videoWidth
        srcHeight = video.videoHeight
      } else {
        const img = element as HTMLImageElement
        srcWidth = img.naturalWidth
        srcHeight = img.naturalHeight
      }

      if (srcWidth === 0 || srcHeight === 0) return

      const srcAspect = srcWidth / srcHeight
      const destAspect = width / height

      let drawWidth: number
      let drawHeight: number
      let offsetX: number
      let offsetY: number

      if (srcAspect > destAspect) {
        drawHeight = height
        drawWidth = height * srcAspect
        offsetX = (width - drawWidth) / 2
        offsetY = 0
      } else {
        drawWidth = width
        drawHeight = width / srcAspect
        offsetX = 0
        offsetY = (height - drawHeight) / 2
      }

      ctx.save()
      ctx.globalAlpha = alpha
      if (blur > 0) {
        ctx.filter = `blur(${blur}px)`
      }
      ctx.drawImage(element, offsetX, offsetY, drawWidth, drawHeight)
      ctx.restore()
    }

    if (isTransitioningRef.current && currentSourceRef.current && nextSourceRef.current) {
      const elapsed = performance.now() - transitionStartTimeRef.current
      const progress = Math.min(elapsed / TRANSITION_DURATION, 1)

      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2
      const maxBlur = 24 * window.devicePixelRatio

      drawCover(nextSourceRef.current, 1, 0)
      drawCover(currentSourceRef.current, 1 - eased, eased * maxBlur)

      if (progress >= 1) {
        isTransitioningRef.current = false
        currentSourceRef.current = nextSourceRef.current
        nextSourceRef.current = null
      }
    } else if (currentSourceRef.current) {
      drawCover(currentSourceRef.current, 1)
    }

    animationFrameRef.current = requestAnimationFrame(drawFrame)
  }, [])

  const loadMedia = useCallback((url: string, isVideo: boolean): Promise<MediaSource> => {
    return new Promise((resolve, reject) => {
      if (isVideo) {
        const video = document.createElement('video')
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.preload = 'auto'
        video.crossOrigin = 'anonymous'

        video.oncanplaythrough = () => {
          video.play()
          resolve({ type: 'video', element: video, url })
        }
        video.onerror = () => reject()
        video.src = url
        video.load()
      } else {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve({ type: 'image', element: img, url })
        img.onerror = () => reject()
        img.src = url
      }
    })
  }, [])

  const transitionTo = useCallback(async (url: string, isVideo: boolean) => {
    try {
      const newSource = await loadMedia(url, isVideo)

      if (!currentSourceRef.current) {
        currentSourceRef.current = newSource
        currentUrlRef.current = url
      } else {
        nextSourceRef.current = newSource
        isTransitioningRef.current = true
        transitionStartTimeRef.current = performance.now()
        currentUrlRef.current = url
      }
    } catch {}
  }, [loadMedia])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const updateSize = () => {
      canvas.width = window.innerWidth * window.devicePixelRatio
      canvas.height = window.innerHeight * window.devicePixelRatio
    }

    updateSize()
    window.addEventListener('resize', updateSize)

    animationFrameRef.current = requestAnimationFrame(drawFrame)

    return () => {
      window.removeEventListener('resize', updateSize)
      cancelAnimationFrame(animationFrameRef.current)
    }
  }, [drawFrame])

  useEffect(() => {
    if (albumArtFetching) return

    const isPlaying = currentTrack?.isPlaying
    const animatedUrl = isPlaying ? albumArt?.animatedUrl : null
    const imageUrl = isPlaying ? albumArt?.imageUrl : null
    const targetUrl = animatedUrl || imageUrl || placeholder || null

    if (!targetUrl || targetUrl === currentUrlRef.current) return

    if (isTransitioningRef.current) return

    transitionTo(targetUrl, !!animatedUrl)
  }, [albumArt, albumArtFetching, currentTrack, placeholder, transitionTo])

  return (
    <canvas
      ref={canvasRef}
      className="w-screen h-screen bg-black"
      style={{ display: 'block' }}
    />
  )
}
