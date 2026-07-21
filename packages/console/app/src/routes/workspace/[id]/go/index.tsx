import { Navigate, useParams } from "@solidjs/router"

export default function () {
  const params = useParams()
  return <Navigate href={`/workspace/${params.id}`} />
}
