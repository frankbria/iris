import { contactLabel, readContacts } from "@/lib/contacts"

/** A configured contact as a link, or its `[placeholder]` while unset (#348). */
export function ContactLink({
  url,
  placeholder,
}: {
  url: string | null
  placeholder: string
}) {
  if (!url) return <span>{placeholder}</span>
  return (
    <a href={url} className="underline">
      {contactLabel(url)}
    </a>
  )
}

/** Shown on every org page while the org is suspended (#348). */
export function SuspendedBanner({
  support = readContacts().support,
}: {
  support?: string | null
}) {
  return (
    <p
      role="note"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
    >
      This organization is suspended. Contact{" "}
      <ContactLink url={support} placeholder="[support contact]" />.
    </p>
  )
}
