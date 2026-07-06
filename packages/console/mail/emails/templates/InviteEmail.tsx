// @ts-nocheck
import React from "react"
import { Img, Row, Html, Link, Body, Head, Button, Column, Preview, Section, Container } from "@jsx-email/all"
import { Text, Fonts, Title, A, Span } from "../components"
import {
  unit,
  body,
  frame,
  headingText,
  container,
  contentText,
  button,
  contentHighlightText,
  linkText,
  buttonText,
} from "../styles"

const CONSOLE_URL = "https://mongolgpt.duckdns.org/"

interface InviteEmailProps {
  inviter: string
  workspaceID: string
  workspaceName: string
  assetsUrl: string
}
export const InviteEmail = ({
  inviter = "test@mongolgpt.duckdns.org",
  workspaceID = "wrk_01K6XFY7V53T8XN0A7X8G9BTN3",
  workspaceName = "mongolgpt",
  assetsUrl = `${CONSOLE_URL}email`,
}: InviteEmailProps) => {
  const messagePlain = `${inviter} таныг ${workspaceName} ажлын талбарт нэгдэхээр урьсан байна.`
  const url = `${CONSOLE_URL}workspace/${workspaceID}`
  return (
    <Html lang="mn">
      <Head>
        <Title>{`MongolGPT - ${messagePlain}`}</Title>
      </Head>
      <Fonts assetsUrl={assetsUrl} />
      <Preview>{messagePlain}</Preview>
      <Body style={body} id={Math.random().toString()}>
        <Container style={container}>
          <Section style={frame}>
            <Row>
              <Column>
                <A href={`${CONSOLE_URL}zen`}>
                  <Img height="32" alt="MongolGPT лого" src={`${assetsUrl}/logo.png`} />
                </A>
              </Column>
            </Row>

            <Section style={{ padding: `${unit * 2}px 0 0 0` }}>
              <Text style={headingText}>Багийнхаа MongolGPT ажлын талбарт нэгдээрэй</Text>
              <Text style={contentText}>
                <Span style={contentHighlightText}>{inviter}</Span> таныг MongolGPT дээрх{" "}
                <Span style={contentHighlightText}>{workspaceName}</Span> ажлын талбарт нэгдэхээр урьсан байна.
              </Text>
            </Section>

            <Section style={{ padding: `${unit}px 0 0 0` }}>
              <Button style={button} href={url}>
                <Text style={buttonText}>
                  Ажлын талбарт нэгдэх
                  <Img width="24" height="24" src={`${assetsUrl}/right-arrow.png`} alt="Баруун сум" />
                </Text>
              </Button>
            </Section>

            <Section style={{ padding: `${unit}px 0 0 0` }}>
              <Text style={contentText}>Товч ажиллахгүй байна уу? Доорх холбоосыг хуулна уу.</Text>
              <Link href={url}>
                <Text style={linkText}>{url}</Text>
              </Link>
            </Section>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

export default InviteEmail
