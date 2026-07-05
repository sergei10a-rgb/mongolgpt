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
      <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="5.4" fill="#151111" />
      <path
        d="M8.4 7.9L13.8 12L8.4 16.1"
        stroke="white"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M14.6 16.1H18" stroke="#26E6F2" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="17" cy="7.9" r="1.25" fill="#37F28B" />
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
      <rect x="6.4" y="6.4" width="83.2" height="83.2" rx="21.6" fill="#151111" />
      <path
        d="M33.4 31.5L55 48L33.4 64.5"
        stroke="white"
        stroke-width="10.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M58.1 64.3H71.7" stroke="#26E6F2" stroke-width="8.8" stroke-linecap="round" />
      <circle cx="67.5" cy="31.8" r="4.8" fill="#37F28B" />
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
      <rect x="10" y="14" width="68" height="68" rx="18" fill="#151111" />
      <path
        d="M32.4 36.7L49 48L32.4 59.3"
        stroke="white"
        stroke-width="7.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M52.6 59.2H63.4" stroke="#26E6F2" stroke-width="6.8" stroke-linecap="round" />
      <circle cx="60.8" cy="36.8" r="3.9" fill="#37F28B" />
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
    </svg>
  )
}
