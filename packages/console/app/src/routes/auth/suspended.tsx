import { Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import styles from "./suspended.module.css"

export default function AccountSuspendedPage() {
  return (
    <main class={styles.page}>
      <section class={styles.content} aria-labelledby="suspended-title">
        <span class={styles.mark} aria-hidden="true">
          M
        </span>
        <p class={styles.eyebrow}>Нэвтрэх эрх</p>
        <Title>MongolGPT аккаунт түр түдгэлзсэн</Title>
        <h1 id="suspended-title">Аккаунт түр түдгэлзсэн байна</h1>
        <p>
          Таны Web, Desktop, CLI болон API key ашиглах эрх түр хаагдсан. Асуудлыг шалгуулахын тулд MongolGPT-ийн
          админтай холбогдоно уу.
        </p>
        <A class={styles.action} href="/auth/logout">
          Сессээс гарах
        </A>
      </section>
    </main>
  )
}
