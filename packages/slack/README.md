# @mongolgpt/slack

Хэлхээ бүрт тусдаа MongolGPT сешн үүсгэн ажилладаг Slack bot-ийн интеграц.

## Тохируулах

1. https://api.slack.com/apps хаягаар Slack app үүсгэнэ.
2. Socket Mode-ийг идэвхжүүлнэ.
3. Дараах OAuth scope-уудыг нэмнэ:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `groups:history`
4. App-ийг workspace-дээ суулгана.
5. `.env` файлд орчны хувьсагчдыг тохируулна:
   - `SLACK_BOT_TOKEN` - Bot User OAuth Token
   - `SLACK_SIGNING_SECRET` - Basic Information хэсгийн Signing Secret
   - `SLACK_APP_TOKEN` - Basic Information хэсгийн App-Level Token

## Ашиглах

```bash
# .env файлд Slack app-ийн нууц утгуудыг тохируулна
bun dev
```

Bot нэмэгдсэн сувгуудад ирсэн зурваст хариулж, хэлхээ бүрт тусдаа MongolGPT сешн үүсгэнэ.
