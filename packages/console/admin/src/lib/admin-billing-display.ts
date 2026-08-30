export function adminInvoiceStatusTime(invoice: {
  timeCreated: string
  timeVerified: string | null
  timeExpired: string | null
  timeCancelled: string | null
  timeRefunded: string | null
}) {
  return (
    invoice.timeRefunded ?? invoice.timeVerified ?? invoice.timeCancelled ?? invoice.timeExpired ?? invoice.timeCreated
  )
}
