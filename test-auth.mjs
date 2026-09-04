const STORE = process.env.SHOPIFY_STORE
  ?.replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Faltan datos en el archivo .env");
  process.exit(1);
}

async function main() {
  // 1. Obtener access token temporal
  const tokenResponse = await fetch(
    `https://${STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    console.error("❌ No se pudo obtener acceso a Shopify.");
    console.error(tokenData);
    process.exit(1);
  }

  // 2. Probar el token contra Shopify
  const response = await fetch(
    `https://${STORE}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": tokenData.access_token,
      },
      body: JSON.stringify({
        query: `{ shop { name } }`,
      }),
    }
  );

  const data = await response.json();

  if (data.errors) {
    console.error("❌ Error al consultar Shopify:");
    console.error(data.errors);
    process.exit(1);
  }

  console.log("✅ CONEXIÓN CORRECTA");
  console.log("Tienda:", data.data.shop.name);
  console.log("Token temporal obtenido correctamente.");
}

main();