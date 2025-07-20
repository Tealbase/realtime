import { createClient } from '@tealbase/tealbase-js'

const tealbaseClient = createClient(
  process.env.NEXT_PUBLIC_tealbase_URL!,
  process.env.NEXT_PUBLIC_tealbase_ANON_KEY!,
  {
    realtime: {
      params: {
        eventsPerSecond: 1000,
      },
    },
  }
)

export default tealbaseClient
