# MongolGPT-д зориулсан GitHub Action

[MongolGPT](https://github.com/sergei10a-rgb/mongolgpt)-ийг GitHub-ийн ажлын урсгалд шууд нэгтгэдэг GitHub Action.

Сэтгэгдэлдээ `/mongolgpt` гэж бичихэд MongolGPT хүсэлтийг GitHub Actions-ийн ажиллуулагч орчинд гүйцэтгэнэ.

## Боломжууд

#### Асуудлыг тайлбарлуулах

GitHub-д бүртгэсэн асуудал дээр дараах сэтгэгдлийг үлдээнэ үү. `mongolgpt` бүх сэтгэгдлийг багтаасан хэлэлцүүлгийг бүтнээр нь уншаад ойлгомжтой тайлбар өгнө.

```
/mongolgpt explain this issue
```

#### Асуудлыг засуулах

GitHub-д бүртгэсэн асуудал дээр дараах сэтгэгдлийг үлдээнэ үү. MongolGPT шинэ салбар үүсгэж, өөрчлөлтийг хэрэгжүүлээд PR нээнэ.

```
/mongolgpt fix this
```

#### PR-ийг хянуулж, өөрчлөлт хийлгэх

GitHub PR дээр дараах сэтгэгдлийг үлдээнэ үү. MongolGPT хүссэн өөрчлөлтийг хэрэгжүүлээд тухайн PR-д шууд нэмнэ.

```
Delete the attachment from S3 when the note is removed /oc
```

#### Кодын тодорхой мөрүүдийг хянуулах

PR-ийн `Files` таб дахь кодын мөрөн дээр шууд сэтгэгдэл үлдээнэ үү. MongolGPT файл, мөрийн дугаар болон өөрчлөлтийн ойр орчмын мэдээллийг автоматаар таньж, нарийвчилсан хариу өгнө.

```
[Comment on specific lines in Files tab]
/oc add error handling here
```

Тодорхой мөрөн дээр сэтгэгдэл үлдээхэд MongolGPT дараах мэдээллийг хүлээн авна:

- Хянаж буй файл
- Сонгосон кодын мөрүүд
- Өөрчлөлтийн эргэн тойрны мэдээлэл
- Мөрийн дугаарууд

Ингэснээр файлын зам эсвэл мөрийн дугаарыг гараар дурдахгүйгээр хүсэлтээ тодорхой хэсэгт чиглүүлэх боломжтой.

## Суулгах

GitHub репогийн хавтас дахь терминалаас дараах командыг ажиллуулна уу:

```bash
mongolgpt github install
```

Энэ команд GitHub App-ийг суулгах, ажлын урсгалын файл үүсгэх, GitHub Actions-ийн нууц утгуудыг тохируулах алхмуудыг дарааллаар нь заана.

### Гараар тохируулах

1. GitHub App-ийг https://github.com/apps/mongolgpt-agent холбоосоос суулгаад холбох репод идэвхжсэн эсэхийг шалгана уу.
2. Реподоо дараах ажлын урсгалын файлыг `.github/workflows/mongolgpt.yml` замаар нэмнэ үү. Тохирох `model` болон шаардлагатай API түлхүүрүүдийг `env` дотор тохируулна.

   ```yml
   name: mongolgpt

   on:
     issue_comment:
       types: [created]
     pull_request_review_comment:
       types: [created]

   jobs:
     mongolgpt:
       if: |
         contains(github.event.comment.body, '/oc') ||
         contains(github.event.comment.body, '/mongolgpt')
       runs-on: ubuntu-latest
       permissions:
         id-token: write
       steps:
          - name: Checkout repository
            uses: actions/checkout@v6
            with:
              fetch-depth: 1
              persist-credentials: false

          - name: Run mongolgpt
           uses: sergei10a-rgb/mongolgpt/github@latest
           env:
             ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
             GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           with:
             model: anthropic/claude-sonnet-4-20250514
             use_github_token: true
   ```

3. API түлхүүрүүдээ нууц утгаар хадгална уу. Байгууллага эсвэл төслийн **settings** рүү орж, зүүн талын **Secrets and variables** цэсийг дэлгээд **Actions**-ийг сонгоно. Дараа нь шаардлагатай API түлхүүрүүдийг нэмнэ.

## Тусламж

Энэ бол эхний хувилбар. Асуудал гарвал эсвэл санал хүсэлт байвал https://github.com/sergei10a-rgb/mongolgpt/issues хаягаар шинэ асуудал бүртгүүлнэ үү.

## Хөгжүүлэлт

Локал орчинд туршихын тулд:

1. Туршилтын репо руу (жишээ нь `hello-world`) шилжинэ үү:

   ```bash
   cd hello-world
   ```

2. Дараах командыг ажиллуулна уу:

   ```bash
   MODEL=anthropic/claude-sonnet-4-20250514 \
     ANTHROPIC_API_KEY=sk-ant-api03-1234567890 \
     GITHUB_RUN_ID=dummy \
     MOCK_TOKEN=github_pat_1234567890 \
     MOCK_EVENT='{"eventName":"issue_comment",...}' \
     bun /path/to/mongolgpt/github/index.ts
   ```

   - `MODEL`: MongolGPT-ийн ашиглах загвар. GitHub-ийн ажлын урсгалд тодорхойлсон `MODEL`-тэй ижил байна.
   - `ANTHROPIC_API_KEY`: Загвар нийлүүлэгчийн API түлхүүр. GitHub-ийн ажлын урсгалд тодорхойлсон түлхүүртэй ижил байна.
   - `GITHUB_RUN_ID`: GitHub Action орчныг дуурайлгах туршилтын утга.
   - `MOCK_TOKEN`: GitHub-ийн хувийн хандалтын токен. Энэ токеноор туршилтын репод `admin` эсвэл `write` эрхтэй эсэхийг шалгана. Токеноо [эндээс](https://github.com/settings/personal-access-tokens) үүсгэнэ үү.
   - `MOCK_EVENT`: GitHub үйл явдлын туршилтын өгөгдөл (доорх загваруудыг харна уу).
   - `/path/to/mongolgpt`: Хуулбарласан MongolGPT репогийн зам. `bun /path/to/mongolgpt/github/index.ts` нь `mongolgpt`-ийн локал хувилбарыг ажиллуулна.

### Асуудал дээр сэтгэгдэл нэмэх үйл явдал

```
MOCK_EVENT='{"eventName":"issue_comment","repo":{"owner":"sst","repo":"hello-world"},"actor":"fwang","payload":{"issue":{"number":4},"comment":{"id":1,"body":"hey mongolgpt, summarize thread"}}}'
```

Дараах утгуудыг солино уу:

- `"owner":"sst"`-ийг репо эзэмшигчийн нэрээр
- `"repo":"hello-world"`-ийг репогийн нэрээр
- `"actor":"fwang"`-ийг сэтгэгдэл бичих хүний GitHub хэрэглэгчийн нэрээр
- `"number":4`-ийг GitHub асуудлын дугаараар
- `"body":"hey mongolgpt, summarize thread"`-ийг сэтгэгдлийн агуулгаар

### Зураг хавсаргасан асуудлын сэтгэгдэл

```
MOCK_EVENT='{"eventName":"issue_comment","repo":{"owner":"sst","repo":"hello-world"},"actor":"fwang","payload":{"issue":{"number":4},"comment":{"id":1,"body":"hey mongolgpt, what is in my image ![Image](https://github.com/user-attachments/assets/xxxxxxxx)"}}}'
```

Зургийн `https://github.com/user-attachments/assets/xxxxxxxx` URL-ийг хүчинтэй GitHub хавсралтын холбоосоор солино уу. Аль нэг асуудал дээр зурагтай сэтгэгдэл үлдээж ийм холбоос үүсгэж болно.

### PR дээр сэтгэгдэл нэмэх үйл явдал

```
MOCK_EVENT='{"eventName":"issue_comment","repo":{"owner":"sst","repo":"hello-world"},"actor":"fwang","payload":{"issue":{"number":4,"pull_request":{}},"comment":{"id":1,"body":"hey mongolgpt, summarize thread"}}}'
```

### PR хяналтын сэтгэгдлийн үйл явдал

```
MOCK_EVENT='{"eventName":"pull_request_review_comment","repo":{"owner":"sst","repo":"hello-world"},"actor":"fwang","payload":{"pull_request":{"number":7},"comment":{"id":1,"body":"hey mongolgpt, add error handling","path":"src/components/Button.tsx","diff_hunk":"@@ -45,8 +45,11 @@\n- const handleClick = () => {\n-   console.log('clicked')\n+ const handleClick = useCallback(() => {\n+   console.log('clicked')\n+   doSomething()\n+ }, [doSomething])","line":47,"original_line":45,"position":10,"commit_id":"abc123","original_commit_id":"def456"}}}'
```
