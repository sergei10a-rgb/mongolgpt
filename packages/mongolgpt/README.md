# MongolGPT CLI

MongolGPT бол Монгол хэлээр анхдагчаар ажиллах AI кодын агент юм. Энэ npm багц нь Windows, macOS, Linux дээр ажиллах `mongolgpt` командыг суулгана.

## Суулгах

Node.js 20 буюу түүнээс шинэ хувилбар дээр:

```bash
npm install --global mongolgpt
```

Дараа нь төсөл дотроо ажиллуулна:

```bash
mongolgpt
```

## MongolGPT бүртгэлээр нэвтрэх

```bash
mongolgpt account login
```

Команд нь MongolGPT-ийн аюулгүй нэвтрэх хуудсыг browser-т нээнэ. Нэвтэрсний дараа Free Auto болон таны багцын эрх CLI-д автоматаар холбогдоно.

## Өөрийн загвар, үйлчилгээ үзүүлэгч ашиглах

MongolGPT бүртгэл нь үндсэн нэвтрэлт боловч та өөрийн API түлхүүр, локал загвар, MCP сервер, skill, plugin, connector-оо нэмж болно.

Жишээ нь гаднын MCP эх сурвалжийг таньж, тохиргоонд тааруулахын өмнө төлөвлөгөөг нь харна:

```bash
mongolgpt compat import plan "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

Дараа нь хэрэгжүүлнэ:

```bash
mongolgpt compat import apply "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

## Тусламж

- [MongolGPT](https://mgpt.mn/)
- [Монгол баримт бичиг](https://docs.mgpt.mn/docs/)
- [Асуудал мэдээлэх](https://github.com/sergei10a-rgb/mongolgpt/issues)
- [Нийгэмлэг](https://github.com/sergei10a-rgb/mongolgpt/discussions)

Лиценз: MIT
