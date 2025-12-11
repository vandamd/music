import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  CurrentTrack,
  LastFmResponse,
  ArtworkApiResponse,
} from '../types/lastfm'

const getCurrentTrack = createServerFn({ method: 'GET' })
  .inputValidator((data: string) => data)
  .handler(async ({ data }): Promise<CurrentTrack> => {
    const username = data
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${process.env.LAST_FM_API_KEY}&format=json&limit=1`
    const response = await fetch(url)
    const apiData = (await response.json()) as LastFmResponse

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

async function imageUrlToBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

const getAlbumArt = createServerFn({ method: 'GET' })
  .inputValidator((data: { artist: string; album: string }) => data)
  .handler(async ({ data }): Promise<string | null> => {
    const searchTerm = `${data.artist} ${data.album}`
    const response = await fetch('https://artwork.dodoapps.io/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: searchTerm, storefront: 'us', type: 'album' }),
    })
    const result = (await response.json()) as ArtworkApiResponse

    if (result.error || !result.images?.length) return null

    return result.images[0].large
  })

export const Route = createFileRoute('/$username')({
  component: UserListening,
  validateSearch: (search: Record<string, unknown>) => ({
    placeholder: typeof search.placeholder === 'string' ? search.placeholder : undefined,
  }),
  loader: async ({ params }) =>
    await getCurrentTrack({ data: params.username }),
})

type DisplayState = {
  url: string | null
  track?: string
  artist?: string
}

function UserListening() {
  const { username } = Route.useParams()
  const { placeholder } = Route.useSearch()
  const initialData = Route.useLoaderData()
  const [currentDisplay, setCurrentDisplay] = useState<DisplayState | null>(null)
  const [previousDisplay, setPreviousDisplay] = useState<DisplayState | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const currentDisplayRef = useRef<DisplayState | null>(null)
  const [cachedPlaceholder, setCachedPlaceholder] = useState<string | null>(null)

  const cachePlaceholder = useCallback(async () => {
    if (!placeholder || cachedPlaceholder) return
    const base64 = await imageUrlToBase64(placeholder)
    if (base64) setCachedPlaceholder(base64)
  }, [placeholder, cachedPlaceholder])

  useEffect(() => {
    cachePlaceholder()
  }, [cachePlaceholder])

  const { data: currentTrack } = useQuery({
    queryKey: ['currentTrack', username],
    queryFn: () => getCurrentTrack({ data: username }),
    initialData,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
  })

  const { data: albumArt, isFetching: albumArtFetching } = useQuery({
    queryKey: ['albumArt', currentTrack?.artist, currentTrack?.album],
    queryFn: () =>
      getAlbumArt({ data: { artist: currentTrack.artist, album: currentTrack.album } }),
    enabled: !!currentTrack?.artist && !!currentTrack?.album,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })

  const activePlaceholder = cachedPlaceholder || placeholder

  useEffect(() => {
    if (albumArtFetching) return

    const isPlaying = currentTrack?.isPlaying
    const artUrl = isPlaying ? (albumArt || activePlaceholder) : activePlaceholder
    const newDisplay: DisplayState = {
      url: artUrl ?? null,
      track: isPlaying ? currentTrack?.track : undefined,
      artist: isPlaying ? currentTrack?.artist : undefined,
    }

    const isSameDisplay = currentDisplayRef.current?.url === newDisplay.url

    if (isSameDisplay) return

    const startTransition = () => {
      if (currentDisplayRef.current) {
        setPreviousDisplay(currentDisplayRef.current)
        setCurrentDisplay(newDisplay)
        currentDisplayRef.current = newDisplay
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setIsTransitioning(true)
            setTimeout(() => {
              setIsTransitioning(false)
              setPreviousDisplay(null)
            }, 1500)
          })
        })
      } else {
        setCurrentDisplay(newDisplay)
        currentDisplayRef.current = newDisplay
      }
    }

    if (newDisplay.url) {
      const img = new Image()
      img.onload = startTransition
      img.src = newDisplay.url
    } else {
      startTransition()
    }
  }, [albumArt, albumArtFetching, currentTrack, activePlaceholder])

  return (
    <div className="w-screen h-screen bg-black relative overflow-hidden">
      {currentDisplay && (
        <DisplayContent display={currentDisplay} />
      )}
      {previousDisplay && (
        <div className={`absolute inset-0 transition-all duration-1500 ease-in-out ${isTransitioning ? 'opacity-0 blur-xl' : 'opacity-100 blur-0'}`}>
          <DisplayContent display={previousDisplay} />
        </div>
      )}
    </div>
  )
}

function DisplayContent({ display }: { display: DisplayState }) {
  if (!display.url) {
    return <div className="absolute inset-0 bg-black" />
  }
  return (
    <img
      src={display.url}
      className="absolute inset-0 w-full h-full object-cover"
      alt={display.track ? `${display.track} by ${display.artist}` : 'Placeholder'}
    />
  )
}
