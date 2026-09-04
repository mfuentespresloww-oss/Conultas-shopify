const STORE = process.env.SHOPIFY_STORE
  ?.replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Faltan datos en .env");
  process.exit(1);
}

async function getAccessToken() {
  const response = await fetch(
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

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("❌ Error obteniendo access token");
    console.error(data);
    process.exit(1);
  }

  return data.access_token;
}

async function main() {
  const token = await getAccessToken();

  const query = `
    query {
      orders(
        first: 30
        sortKey: CREATED_AT
        reverse: true
      ) {
        nodes {
          name
          createdAt
          cancelledAt
          displayFinancialStatus

          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          paymentGatewayNames

          events(first: 30) {
            nodes {
              action
              createdAt
              message
            }
          }
        }
      }
    }
  `;

  const response = await fetch(
    `https://${STORE}/admin/api/2026-07/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query }),
    }
  );

  const result = await response.json();

  if (result.errors) {
    console.error("❌ Error GraphQL:");
    console.dir(result.errors, { depth: null });
    process.exit(1);
  }

  const orders = result.data.orders.nodes;

  const accionesPago = [
    "sale_pending",
    "sale_success",
    "sale_failure",
    "authorization_pending",
    "authorization_success",
    "authorization_failure",
    "capture_pending",
    "capture_success",
    "capture_failure",
    "cancelled",
  ];

  let encontrados = 0;

  for (const order of orders) {
    const eventos = order.events.nodes
      .filter((e) => accionesPago.includes(e.action))
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() -
          new Date(b.createdAt).getTime()
      );

    const pending = eventos.find(
      (e) =>
        e.action === "sale_pending" ||
        e.action === "authorization_pending" ||
        e.action === "capture_pending"
    );

    // Por ahora solo nos interesan pedidos que hayan tenido pendiente
    if (!pending) continue;

    encontrados++;

    const success = eventos.find(
      (e) =>
        new Date(e.createdAt) >= new Date(pending.createdAt) &&
        (
          e.action === "sale_success" ||
          e.action === "capture_success"
        )
    );

    const failure = eventos.find(
      (e) =>
        new Date(e.createdAt) >= new Date(pending.createdAt) &&
        (
          e.action === "sale_failure" ||
          e.action === "capture_failure"
        )
    );

    const cancelled = eventos.find(
      (e) => e.action === "cancelled"
    );

    let resultado = "🟡 SIGUE / QUEDÓ PENDIENTE";

    if (success) {
      resultado = "🟢 PENDIENTE → PAGADO";
    } else if (
      failure ||
      cancelled ||
      order.displayFinancialStatus === "EXPIRED"
    ) {
      resultado = "🔴 PENDIENTE → NO CONVERTIDO";
    }

    console.log("\n============================================");
    console.log("PEDIDO:", order.name);
    console.log(
      "Total:",
      order.totalPriceSet.shopMoney.amount,
      order.totalPriceSet.shopMoney.currencyCode
    );
    console.log(
      "Gateway:",
      order.paymentGatewayNames.join(", ") || "-"
    );
    console.log(
      "Estado actual:",
      order.displayFinancialStatus
    );

    console.log("\nRESULTADO:", resultado);

    console.log("\nEVENTOS DE PAGO:");

    for (const evento of eventos) {
      console.log(
        evento.createdAt,
        "|",
        evento.action,
        "|",
        evento.message
      );
    }

    if (pending && success) {
      const minutos =
        (new Date(success.createdAt) -
          new Date(pending.createdAt)) /
        60000;

      console.log(
        "\n⏱️ Tiempo de pendiente a pagado:",
        minutos.toFixed(1),
        "minutos"
      );
    }
  }

  console.log("\n============================================");

  if (encontrados === 0) {
    console.log(
      "⚠️ No encontramos eventos PENDING entre los últimos 30 pedidos."
    );
  } else {
    console.log(
      `✅ Pedidos con evento PENDING encontrados: ${encontrados}`
    );
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
});