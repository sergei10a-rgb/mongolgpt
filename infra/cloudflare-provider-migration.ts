if (process.env.MONGOLGPT_CLOUDFLARE_PROVIDER_MIGRATION !== "true") {
  throw new Error("Cloudflare provider migration module is restricted to the explicit migration workflow.")
}

export const usageDeadLetterQueue = new sst.cloudflare.Queue("UsageDeadLetterQueue")
export const usageQueue = new sst.cloudflare.Queue("UsageQueue", {
  dlq: {
    queue: usageDeadLetterQueue.nodes.queue.queueName,
    retry: 5,
    retryDelay: "30 seconds",
  },
})
