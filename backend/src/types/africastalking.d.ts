/**
 * Minimal declarations for the Africa's Talking SDK, which ships none.
 *
 * Only the surface FundX uses is described. Declaring it beats casting to `any`: the SMS
 * call is how a user learns their money moved, and a typo in the payload shape should fail
 * at build time rather than silently drop notifications.
 */
declare module "africastalking" {
  type SmsOptions = {
    to: string[]
    message: string
    from?: string
    enqueue?: boolean
  }

  type SmsRecipient = {
    number: string
    status: string
    statusCode: number
    messageId?: string
    cost?: string
  }

  type SmsResponse = {
    SMSMessageData: {
      Message: string
      Recipients: SmsRecipient[]
    }
  }

  type Client = {
    SMS: { send(options: SmsOptions): Promise<SmsResponse> }
  }

  export default function AfricasTalking(credentials: {
    apiKey: string
    username: string
  }): Client
}
