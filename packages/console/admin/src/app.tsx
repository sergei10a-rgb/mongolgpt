import { MetaProvider, Title } from "@solidjs/meta"
import { Router } from "@solidjs/router"
import { FileRoutes } from "@solidjs/start/router"
import { Suspense } from "solid-js"
import "./app.css"

export default function App() {
  return (
    <Router
      explicitLinks={true}
      // Single-flight requires a Referer header, which our no-referrer policy intentionally omits.
      singleFlight={false}
      root={(props) => (
        <MetaProvider>
          <Title>MongolGPT удирдлага</Title>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  )
}
