import { MetaProvider, Title } from "@solidjs/meta"
import { Router } from "@solidjs/router"
import { FileRoutes } from "@solidjs/start/router"
import { ErrorBoundary, Suspense } from "solid-js"
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
          <ErrorBoundary
            fallback={
              <main data-page="admin-overview">
                <section data-component="page-heading">
                  <div>
                    <p data-component="eyebrow">MongolGPT удирдлага</p>
                    <h1>Мэдээллийг ачаалж чадсангүй</h1>
                    <p role="alert">Холболтоо шалгаад хуудсаа дахин ачаална уу. Өмнөх үйлдлийг давтан илгээхгүй.</p>
                  </div>
                  <button data-component="load-error-action" type="button" onClick={() => window.location.reload()}>
                    Дахин ачаалах
                  </button>
                </section>
              </main>
            }
          >
            <Suspense>{props.children}</Suspense>
          </ErrorBoundary>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  )
}
