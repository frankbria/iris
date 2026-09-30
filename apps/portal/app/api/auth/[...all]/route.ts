import { getAuth } from "@/lib/auth"

const handle = (request: Request) => getAuth().handler(request)

export { handle as GET, handle as POST }
