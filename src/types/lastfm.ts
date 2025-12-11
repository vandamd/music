export type CurrentTrack = {
  track: string
  artist: string
  album: string
  isPlaying: boolean
} | null

export type LastFmResponse = {
  recenttracks: {
    track:
      | Array<{
          '@attr'?: { nowplaying: 'true' }
          name: string
          artist: { '#text': string }
          album: { '#text': string }
          image: Array<{ '#text': string; size: string }>
        }>
      | {
          '@attr'?: { nowplaying: 'true' }
          name: string
          artist: { '#text': string }
          album: { '#text': string }
          image: Array<{ '#text': string; size: string }>
        }
  }
  error?: number
  message?: string
}

export type ArtworkApiResponse = {
  images: Array<{
    thumb: string
    large: string
    name: string
    artist: string
  }>
  error?: string
}
