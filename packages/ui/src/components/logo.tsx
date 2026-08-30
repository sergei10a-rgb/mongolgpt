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
        d="M6.8 16.8V7.2L12 12.2L17.2 7.2V16.8"
        stroke="white"
        stroke-width="2.35"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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
        d="M27.2 67.2V28.8L48 48.8L68.8 28.8V67.2"
        stroke="white"
        stroke-width="9.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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
        d="M29.3 62.8V33.2L44 47.5L58.7 33.2V62.8"
        stroke="white"
        stroke-width="7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
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
