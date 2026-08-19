export * as ConfigAttachmentV1 from "./attachment"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Image = Schema.Struct({
  auto_resize: Schema.optional(Schema.Boolean).annotate({
    description: "Зураг тохируулсан хязгаараас хэтэрсэн үед загварт илгээхээс өмнө хэмжээг өөрчлөх (анхдагч: true)",
  }),
  max_width: Schema.optional(PositiveInt).annotate({
    description: "Хэмжээг өөрчлөх эсвэл хавсралтыг хүлээн авахаас татгалзахаас өмнөх зургийн хамгийн их өргөн (анхдагч: 2000)",
  }),
  max_height: Schema.optional(PositiveInt).annotate({
    description: "Хэмжээг өөрчлөх эсвэл хавсралтыг хүлээн авахаас татгалзахаас өмнөх зургийн хамгийн их өндөр (анхдагч: 2000)",
  }),
  max_base64_bytes: Schema.optional(PositiveInt).annotate({
    description: "Зургийн хавсралтын base64 өгөгдлийн дээд хэмжээ, байтаар (анхдагч: 5242880)",
  }),
}).annotate({ identifier: "ImageAttachmentConfig" })
export type Image = Schema.Schema.Type<typeof Image>

export const Info = Schema.Struct({
  image: Schema.optional(Image).annotate({ description: "Зураг хавсаргах тохиргоо" }),
}).annotate({ identifier: "AttachmentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
