import type { Metadata } from "next"
import { connection } from "next/server"

import { ContactLink } from "@/components/contact-link"
import { LegalFooter } from "@/components/legal-document"
import { readContacts } from "@/lib/contacts"

export const metadata: Metadata = { title: "Contact" }

/** Public contacts (#348), from operator configuration; `[placeholder]` when unset. */
export default async function ContactPage() {
  // Runtime configuration: never prerendered with the build's environment.
  await connection()
  const contacts = readContacts()
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-4 p-6 text-sm leading-relaxed">
      <h1 className="font-heading text-lg font-medium">Contact</h1>
      <section aria-labelledby="abuse" className="flex flex-col gap-1">
        <h2 id="abuse" className="font-medium">
          Report abuse
        </h2>
        <p>
          <ContactLink url={contacts.abuse} placeholder="[abuse contact]" />
        </p>
        <p className="text-muted-foreground">
          Include the URL involved, when it happened (with time zone), and the
          organization or API key prefix if you know it.
        </p>
      </section>
      <section aria-labelledby="security" className="flex flex-col gap-1">
        <h2 id="security" className="font-medium">
          Report a security vulnerability
        </h2>
        <p>
          <ContactLink
            url={contacts.security}
            placeholder="[security contact]"
          />
        </p>
        <p className="text-muted-foreground">
          We practise coordinated disclosure: send the details and steps to
          reproduce, and give us reasonable time to fix the issue before
          publishing it.
        </p>
      </section>
      <section aria-labelledby="support" className="flex flex-col gap-1">
        <h2 id="support" className="font-medium">
          Support
        </h2>
        <p>
          <ContactLink url={contacts.support} placeholder="[support contact]" />
        </p>
        <p className="text-muted-foreground">
          Account, billing and suspension questions.
        </p>
      </section>
      <LegalFooter />
    </main>
  )
}
