import { Agent, fetch as resolvedFetch } from "undici";
import { z } from "zod";

const dnsAnswerSchema = z.object({ Answer: z.array(z.object({ type: z.number(), data: z.string() })) });
const IPV4_RECORD_TYPE = 1;
const IPV4_ADDRESS_FAMILY = 4;

export async function deploymentRequest(url: string): Promise<Response> {
  try {
    return await fetch(url, { redirect: "manual" });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOTFOUND") throw error;
    // freshly provisioned DNS may be negatively cached by the machine's recursive resolver.
    const hostname = new URL(url).hostname;
    const dnsResponse = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { Accept: "application/dns-json" },
    });
    const answer = dnsAnswerSchema.parse(await dnsResponse.json());
    const addresses = answer.Answer.filter((record) => record.type === IPV4_RECORD_TYPE)
      .map((record) => ({ address: z.ipv4().parse(record.data), family: IPV4_ADDRESS_FAMILY }));
    const firstAddress = addresses[0];
    if (!firstAddress) throw new Error(`No authoritative address is available for ${hostname}.`);
    const dispatcher = new Agent({ connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, firstAddress.address, firstAddress.family);
      },
    } });
    try {
      const response = await resolvedFetch(url, { redirect: "manual", dispatcher });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    } finally {
      await dispatcher.close();
    }
  }
}
