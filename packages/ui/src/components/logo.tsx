import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#mongolgpt-mark-gradient)" />
      <path
        d="M6.5 14.6V9.2H8.7L12 13.1L15.3 9.2H17.5V14.6"
        stroke="white"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M8 17.2H16" stroke="white" stroke-width="1.8" stroke-linecap="round" />
      <defs>
        <linearGradient id="mongolgpt-mark-gradient" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#13B878" />
          <stop offset="1" stop-color="#178CFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="10" y="10" width="76" height="76" rx="20" fill="url(#mongolgpt-splash-gradient)" />
      <path
        d="M25.5 58.5V36.8H34.3L48 53.1L61.7 36.8H70.5V58.5"
        stroke="white"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M31 70H65" stroke="white" stroke-width="7" stroke-linecap="round" />
      <defs>
        <linearGradient id="mongolgpt-splash-gradient" x1="14" y1="14" x2="82" y2="82" gradientUnits="userSpaceOnUse">
          <stop stop-color="#13B878" />
          <stop offset="1" stop-color="#178CFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 360 96"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <rect x="10" y="14" width="68" height="68" rx="18" fill="url(#mongolgpt-logo-gradient)" />
      <path
        d="M27.5 56.3V37.8H35.1L44 49.2L52.9 37.8H60.5V56.3"
        stroke="white"
        stroke-width="5.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M31.5 66H56.5" stroke="white" stroke-width="5.6" stroke-linecap="round" />
      <text
        x="96"
        y="61"
        fill="var(--icon-strong-base)"
        font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        font-size="39"
        font-weight="800"
        letter-spacing="0"
      >
        MongolGPT
      </text>
      <defs>
        <linearGradient id="mongolgpt-logo-gradient" x1="12" y1="16" x2="78" y2="82" gradientUnits="userSpaceOnUse">
          <stop stop-color="#13B878" />
          <stop offset="1" stop-color="#178CFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
