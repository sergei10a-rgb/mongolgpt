// @ts-nocheck
// Vendored Poe auth plugin source (MIT). MongolGPT local adapter.
const CLIENT_ID = "client_728290227fc048cc9262091a1ea197ea";
function getExpiry(expiresIn) {
    if (expiresIn == null) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Date.now() + expiresIn * 1000;
}
async function authorize() {
    const [{ default: open }, { createOAuthClient }] = await Promise.all([
        import("open"),
        import("poe-oauth")
    ]);
    const client = createOAuthClient({
        clientId: CLIENT_ID,
        landingPage: {
            title: "Poe холбогдлоо",
            body: "Энэ tab-ыг хаагаад MongolGPT рүү буцаж болно."
        },
        openBrowser: async (url) => {
            await open(url);
        }
    });
    const authorization = await client.authorize();
    return {
        url: authorization.authorizationUrl,
        instructions: "Нэвтрэлтийг хөтөч дээрээ дуусгана уу. Энэ цонх автоматаар хаагдана.",
        method: "auto",
        callback: async () => {
            const result = await authorization.waitForResult();
            return {
                type: "success",
                access: result.apiKey,
                refresh: result.apiKey,
                expires: getExpiry(result.expiresIn)
            };
        }
    };
}
export async function PoeAuthPlugin(_input) {
    return {
        auth: {
            provider: "poe",
            async loader(getAuth) {
                const auth = await getAuth();
                if (auth.type === "api") {
                    return { apiKey: auth.key };
                }
                if (auth.type !== "oauth") {
                    return {};
                }
                if (auth.expires < Date.now()) {
                    throw new Error("Poe API key-ийн хугацаа дууссан. `mongolgpt providers login` командыг дахин ажиллуулна уу.");
                }
                return { apiKey: auth.access };
            },
            methods: [
                {
                    label: "Poe-оор нэвтрэх (хөтөч)",
                    type: "oauth",
                    authorize
                },
                {
                    label: "API key гараар оруулах",
                    type: "api"
                }
            ]
        }
    };
}
export default PoeAuthPlugin;

