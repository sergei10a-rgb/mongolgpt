// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server"

export default createHandler(
  () => (
    <StartServer
      document={({ assets, children, scripts }) => (
        <html lang="mn" data-theme="light">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="color-scheme" content="light dark" />
            <meta name="robots" content="noindex,nofollow,noarchive" />
            {assets}
          </head>
          <body>
            <div id="app">{children}</div>
            {scripts}
          </body>
        </html>
      )}
    />
  ),
  {
    mode: "async",
  },
)
