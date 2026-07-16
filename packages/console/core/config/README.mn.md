# MongolGPT Free Auto production тохиргоо

`free-auto.example.json` нь production secret catalog-ийн бүтэц бөгөөд шууд байршуулж болох бодит нууц тохиргоо биш.

Байршуулалтын өмнө:

1. `production-primary`, `production-secondary` үйлчилгээг бодит үйлдвэрлэлийн эрхтэй provider-оор солино.
2. Загварын ID, API URL, нууц түлхүүр болон бодит дотоод өртгийг оруулна.
3. `fallbackProvider` нь `providers` жагсаалтад байгаа provider-ийг зааж буйг шалгана.
4. `rateLimit`-ийг Free багцын нэг минутын хүсэлтийн хязгаарт тохируулна.
5. `freeWeeklyTokenLimit`-ийг нэг ажлын талбарын долоо хоногт ашиглах token-ы дээд хэмжээнд тохируулна.
6. `freeMaxTokensPerRequest`-ийг тухайн route-ийн нэг хүсэлтэд үүсэж болох input, output, reasoning, cache read/write token-ы нийлбэрийн model/provider-аар баталгаажсан дээд хэмжээнд тохируулна. Энэ утга `freeWeeklyTokenLimit`-ээс их байж болохгүй.
7. `ZenData.validate(...)` шалгалтыг давсны дараа JSON-ийг `ZEN_MODELS1`-`ZEN_MODELS30` SST secret-д ачаална.
8. Апп болон CLI орчинд `MONGOLGPT_ENABLE_HOSTED_SERVICES=1`, `MONGOLGPT_CONSOLE_URL`, `MONGOLGPT_AUTH_URL`-ийг өөрийн production хаягаар тохируулна.

`allowAnonymous: false` болон `freeForAuthenticated: true` нь Free Auto-г зөвхөн MongolGPT бүртгэлээр нэвтэрсэн хэрэглэгчид үнэ төлбөргүй тооцох гэрээ юм. NVIDIA-ийн байршуулсан туршилтын API эрхийг нийтийн Free Auto backend болгон ашиглаж болохгүй; зохих үйлдвэрлэлийн лиценз эсвэл тусдаа гэрээ шаардлагатай.
