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
        first: 20
        sortKey: CREATED_AT
        reverse: true
      ) {
        nodes {
          name
          createdAt
          updatedAt
          cancelledAt
          displayFinancialStatus

          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          transactions(first: 50) {
            id
            createdAt
            processedAt
            gateway
            kind
            status

            amountSet {
              shopMoney {
                amount
                currencyCode
              }
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

  console.log(`\n✅ Pedidos encontrados: ${orders.length}\n`);

  for (const order of orders) {
    console.log("==========================================");
    console.log("PEDIDO:", order.name);
    console.log("Creado:", order.createdAt);
    console.log("Estado actual:", order.displayFinancialStatus);
    console.log(
      "Total:",
      order.totalPriceSet.shopMoney.amount,
      order.totalPriceSet.shopMoney.currencyCode
    );

    console.log(
      "Cancelado:",
      order.cancelledAt ? order.cancelledAt : "NO"
    );

    console.log("\nTRANSACCIONES:");

    if (!order.transactions.length) {
      console.log("Sin transacciones");
    }

    for (const tx of order.transactions) {
      console.log(`
Gateway: ${tx.gateway}
Tipo: ${tx.kind}
Estado: ${tx.status}
Creada: ${tx.createdAt}
Procesada: ${tx.processedAt || "-"}
Importe: ${tx.amountSet.shopMoney.amount}
`);
    }

    console.log("");
  }
}

main().catch((error) => {
  console.error("❌ Error:", error);
});