  import fs from "node:fs";

  const STORE = process.env.SHOPIFY_STORE
    ?.replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

  const YEAR = 2026;
  const TIMEZONE = "America/Mexico_City";
  const DESDE = `${YEAR}-01-01T00:00:00-06:00`;

  if (!STORE || !CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Faltan datos en .env");
    process.exit(1);
  }

  // ======================================================
  // AUTENTICACIÓN
  // ======================================================

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
      console.error("❌ No se pudo obtener access token");
      console.error(data);
      process.exit(1);
    }

    return data.access_token;
  }

  // ======================================================
  // GRAPHQL
  // ======================================================

  async function graphql(token, query, variables = {}) {
    const response = await fetch(
      `https://${STORE}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      }
    );

    const result = await response.json();

    if (result.errors) {
      console.error("❌ Error GraphQL:");
      console.dir(result.errors, { depth: null });
      process.exit(1);
    }

    return result.data;
  }

  // ======================================================
  // PEDIDOS
  // ======================================================

  async function getOrders(token) {
    const query = `
      query Pedidos2026($after: String, $query: String!) {
        orders(
          first: 100
          after: $after
          sortKey: CREATED_AT
          query: $query
        ) {
          nodes {
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            paymentGatewayNames

            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            netPaymentSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            events(first: 100) {
              nodes {
                action
                createdAt
                message
              }
            }
          }

          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    let after = null;
    let orders = [];
    let pagina = 1;

    do {
      console.log(`Consultando página ${pagina}...`);

      const data = await graphql(token, query, {
        after,
        query: `created_at:>=${DESDE}`,
      });

      orders.push(...data.orders.nodes);

      after = data.orders.pageInfo.hasNextPage
        ? data.orders.pageInfo.endCursor
        : null;

      pagina++;
    } while (after);

    return orders;
  }

  // ======================================================
  // FECHAS
  // ======================================================

  function getMesKey(fechaISO) {
    const partes = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date(fechaISO));

    const year = partes.find(
      (p) => p.type === "year"
    )?.value;

    const month = partes.find(
      (p) => p.type === "month"
    )?.value;

    return `${year}-${month}`;
  }

  function nombreMes(mesKey) {
    const [year, month] = mesKey.split("-");

    const fecha = new Date(
      Number(year),
      Number(month) - 1,
      1
    );

    const nombre = new Intl.DateTimeFormat("es-MX", {
      month: "long",
    }).format(fecha);

    return (
      nombre.charAt(0).toUpperCase() +
      nombre.slice(1)
    );
  }

  // ======================================================
  // ESTADÍSTICAS
  // ======================================================

  function mediana(valores) {
    if (!valores.length) return null;

    const ordenados = [...valores].sort(
      (a, b) => a - b
    );

    const mitad = Math.floor(
      ordenados.length / 2
    );

    if (ordenados.length % 2 === 0) {
      return (
        (ordenados[mitad - 1] +
          ordenados[mitad]) /
        2
      );
    }

    return ordenados[mitad];
  }

  function pct(parte, total) {
    if (!total) return 0;

    return (parte / total) * 100;
  }

  function redondear(numero, decimales = 2) {
    return Number(
      Number(numero || 0).toFixed(decimales)
    );
  }

  // ======================================================
  // PASARELAS
  // ======================================================

  function normalizarGateway(valor) {
    if (!valor) {
      return "No identificado";
    }

    const texto = String(valor).toLowerCase();

    if (texto.includes("openpay")) {
      return "Openpay";
    }

    if (
      texto.includes("mercado pago checkout pro") ||
      texto.includes("checkout mercado pago")
    ) {
      return "Checkout Mercado Pago";
    }

    if (
      texto.includes("mercado pago tarjetas") ||
      texto.includes("mercado pago tarjeta")
    ) {
      return "Mercado Pago Tarjetas";
    }

    if (texto.includes("paypal")) {
      return "PayPal";
    }

    if (
      texto.includes("aplazo") ||
      texto.includes("compra ahora, paga después") ||
      texto.includes("compra ahora, paga despues")
    ) {
      return "Compra ahora, paga después";
    }

    return valor.trim();
  }

  function extraerGatewayEvento(
    mensaje,
    paymentGatewayNames = []
  ) {
    if (mensaje) {
      const texto = String(mensaje).trim();

      // Ejemplo real:
      // A $1,398.00 MXN payment is pending on Mercado Pago Checkout Pro.

      const matchPendingOn = texto.match(
        /payment is pending on (.+?)(?:\.)?$/i
      );

      if (matchPendingOn?.[1]) {
        return {
          gateway: normalizarGateway(
            matchPendingOn[1]
          ),
          gatewayRaw: matchPendingOn[1].trim(),
        };
      }

      // Fallback para posibles variaciones
      const matchPendingWith = texto.match(
        /payment is pending (?:with|via) (.+?)(?:\.)?$/i
      );

      if (matchPendingWith?.[1]) {
        return {
          gateway: normalizarGateway(
            matchPendingWith[1]
          ),
          gatewayRaw: matchPendingWith[1].trim(),
        };
      }
    }

    if (paymentGatewayNames.length === 1) {
      return {
        gateway: normalizarGateway(
          paymentGatewayNames[0]
        ),
        gatewayRaw: paymentGatewayNames[0],
      };
    }

    return {
      gateway: "No identificado",
      gatewayRaw:
        paymentGatewayNames.join(" | ") ||
        "No identificado",
    };
  }

  // ======================================================
  // ANALIZAR PEDIDO
  // ======================================================

  function analizarPedido(order) {
    const eventos = [...order.events.nodes].sort(
      (a, b) =>
        new Date(a.createdAt) -
        new Date(b.createdAt)
    );

    const eventosPending = eventos.filter((e) =>
      [
        "sale_pending",
        "authorization_pending",
        "capture_pending",
      ].includes(e.action)
    );

    if (!eventosPending.length) {
      return {
        esPending: false,
      };
    }

    const primerPending = eventosPending[0];

    const posteriores = eventos.filter(
      (e) =>
        new Date(e.createdAt) >=
        new Date(primerPending.createdAt)
    );

    const success = posteriores.find((e) =>
      [
        "sale_success",
        "capture_success",
      ].includes(e.action)
    );

    const failure = posteriores.find((e) =>
      [
        "sale_failure",
        "capture_failure",
        "authorization_failure",
      ].includes(e.action)
    );

    const cancelled = posteriores.find(
      (e) => e.action === "cancelled"
    );

    const estado =
      order.displayFinancialStatus;

    const estadoQueIndicaCobro = [
      "PAID",
      "PARTIALLY_PAID",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
    ].includes(estado);

    let resultado;

    if (success || estadoQueIndicaCobro) {
      resultado = "PAGADO";
    } else if (
      failure ||
      cancelled ||
      ["EXPIRED", "VOIDED"].includes(estado)
    ) {
      resultado = "NO_CONVERTIDO";
    } else {
      resultado = "PENDIENTE";
    }

    let fechaResultado = null;

    if (success) {
      fechaResultado = success.createdAt;
    } else if (failure) {
      fechaResultado = failure.createdAt;
    } else if (cancelled) {
      fechaResultado = cancelled.createdAt;
    }

    let minutosConversion = null;

    if (success) {
      minutosConversion =
        (new Date(success.createdAt) -
          new Date(primerPending.createdAt)) /
        60000;
    }

    const gatewayInfo = extraerGatewayEvento(
      primerPending.message,
      order.paymentGatewayNames || []
    );

    return {
      esPending: true,
      resultado,

      primerPending,
      success,
      failure,
      cancelled,

      fechaResultado,
      minutosConversion,

      gateway: gatewayInfo.gateway,
      gatewayRaw: gatewayInfo.gatewayRaw,
    };
  }

  // ======================================================
  // ESTRUCTURAS
  // ======================================================

  function crearMes() {
    return {
      pedidosTotales: 0,
      ventaNetaCobrada: 0,

      pendingTotal: 0,
      pagados: 0,
      noConvertidos: 0,
      pendientes: 0,

      ventaRecuperada: 0,
      valorNoConvertido: 0,
      valorPendiente: 0,

      tiemposConversion: [],

      gateways: {},
    };
  }

  function crearGateway() {
    return {
      total: 0,
      pagados: 0,
      noConvertidos: 0,
      pendientes: 0,

      ventaRecuperada: 0,
      valorNoConvertido: 0,
      valorPendiente: 0,

      tiemposConversion: [],
    };
  }

  // ======================================================
  // CSV
  // ======================================================

  function escaparCSV(valor) {
    if (
      valor === null ||
      valor === undefined
    ) {
      return "";
    }

    const texto = String(valor);

    if (
      texto.includes(",") ||
      texto.includes('"') ||
      texto.includes("\n")
    ) {
      return `"${texto.replace(
        /"/g,
        '""'
      )}"`;
    }

    return texto;
  }

  function crearCSV(filas) {
    if (!filas.length) {
      return "";
    }

    const columnas = Object.keys(filas[0]);

    const lineas = [
      columnas.map(escaparCSV).join(","),
    ];

    for (const fila of filas) {
      lineas.push(
        columnas
          .map((columna) =>
            escaparCSV(fila[columna])
          )
          .join(",")
      );
    }

    // BOM UTF-8 para que Excel abra bien acentos
    return "\uFEFF" + lineas.join("\n");
  }

  // ======================================================
  // MAIN
  // ======================================================

  async function main() {
    console.log(
      "\n📊 EXPORTACIÓN DASHBOARD PENDING 2026"
    );

    console.log(
      "Periodo: 1 enero 2026 → hoy\n"
    );

    const token = await getAccessToken();

    const orders = await getOrders(token);

    console.log(
      `\n✅ Pedidos encontrados: ${orders.length}`
    );

    const meses = {};
    const detallePending = [];

    // ==================================================
    // RECORRER PEDIDOS
    // ==================================================

    for (const order of orders) {
      const mesKey = getMesKey(
        order.createdAt
      );

      if (
        !mesKey.startsWith(`${YEAR}-`)
      ) {
        continue;
      }

      if (!meses[mesKey]) {
        meses[mesKey] = crearMes();
      }

      const mes = meses[mesKey];

      mes.pedidosTotales++;

      const ventaNetaPedido = Number(
        order.netPaymentSet?.shopMoney
          ?.amount || 0
      );

      const totalPedido = Number(
        order.totalPriceSet?.shopMoney
          ?.amount || 0
      );

      mes.ventaNetaCobrada +=
        ventaNetaPedido;

      const analisis =
        analizarPedido(order);

      if (!analisis.esPending) {
        continue;
      }

      mes.pendingTotal++;

      const gateway = analisis.gateway;

      if (!mes.gateways[gateway]) {
        mes.gateways[gateway] =
          crearGateway();
      }

      const g = mes.gateways[gateway];

      g.total++;

      if (
        analisis.resultado === "PAGADO"
      ) {
        mes.pagados++;
        g.pagados++;

        mes.ventaRecuperada +=
          ventaNetaPedido;

        g.ventaRecuperada +=
          ventaNetaPedido;

        if (
          analisis.minutosConversion !==
          null
        ) {
          mes.tiemposConversion.push(
            analisis.minutosConversion
          );

          g.tiemposConversion.push(
            analisis.minutosConversion
          );
        }
      }

      if (
        analisis.resultado ===
        "NO_CONVERTIDO"
      ) {
        mes.noConvertidos++;
        g.noConvertidos++;

        mes.valorNoConvertido +=
          totalPedido;

        g.valorNoConvertido +=
          totalPedido;
      }

      if (
        analisis.resultado ===
        "PENDIENTE"
      ) {
        mes.pendientes++;
        g.pendientes++;

        mes.valorPendiente +=
          totalPedido;

        g.valorPendiente +=
          totalPedido;
      }

      detallePending.push({
        pedido: order.name,

        fecha_creacion:
          order.createdAt,

        mes_key: mesKey,

        mes: nombreMes(mesKey),

        gateway:
          analisis.gateway,

        gateway_raw:
          analisis.gatewayRaw,

        total_pedido:
          redondear(totalPedido),

        venta_neta_cobrada_pedido:
          redondear(ventaNetaPedido),

        estado_actual:
          order.displayFinancialStatus,

        resultado:
          analisis.resultado,

        fecha_pending:
          analisis.primerPending
            ?.createdAt || "",

        fecha_resultado:
          analisis.fechaResultado || "",

        minutos_conversion:
          analisis.minutosConversion !==
          null
            ? redondear(
                analisis.minutosConversion,
                1
              )
            : "",

        mensaje_pending:
          analisis.primerPending
            ?.message || "",
      });
    }

    // ==================================================
    // RESUMEN MENSUAL
    // ==================================================

    const resumenMensual = [];

    const mesesOrdenados =
      Object.keys(meses).sort();

    for (const mesKey of mesesOrdenados) {
      const m = meses[mesKey];

      const resueltos =
        m.pagados +
        m.noConvertidos;

      const promedio =
        m.tiemposConversion.length
          ? m.tiemposConversion.reduce(
              (a, b) => a + b,
              0
            ) /
            m.tiemposConversion.length
          : null;

      const medianaMes = mediana(
        m.tiemposConversion
      );

      resumenMensual.push({
        mes_key: mesKey,

        mes: nombreMes(mesKey),

        pedidos_totales:
          m.pedidosTotales,

        venta_neta_cobrada:
          redondear(
            m.ventaNetaCobrada
          ),

        pending_total:
          m.pendingTotal,

        incidencia_pending_pct:
          redondear(
            pct(
              m.pendingTotal,
              m.pedidosTotales
            )
          ),

        pending_pagados:
          m.pagados,

        pending_no_convertidos:
          m.noConvertidos,

        pending_abiertos:
          m.pendientes,

        pending_resueltos:
          resueltos,

        conversion_pending_pct:
          redondear(
            pct(
              m.pagados,
              resueltos
            )
          ),

        venta_pending_recuperada:
          redondear(
            m.ventaRecuperada
          ),

        recuperada_sobre_venta_pct:
          redondear(
            pct(
              m.ventaRecuperada,
              m.ventaNetaCobrada
            )
          ),

        valor_pending_no_convertido:
          redondear(
            m.valorNoConvertido
          ),

        no_convertido_sobre_venta_pct:
          redondear(
            pct(
              m.valorNoConvertido,
              m.ventaNetaCobrada
            )
          ),

        valor_pending_abierto:
          redondear(
            m.valorPendiente
          ),

        tiempo_promedio_pago_min:
          promedio !== null
            ? redondear(promedio, 1)
            : "",

        tiempo_mediana_pago_min:
          medianaMes !== null
            ? redondear(
                medianaMes,
                1
              )
            : "",
      });
    }

    // ==================================================
    // PASARELAS
    // ==================================================

    const resumenPasarelas = [];

    for (const mesKey of mesesOrdenados) {
      const m = meses[mesKey];

      for (const [
        gateway,
        g,
      ] of Object.entries(m.gateways)) {
        const resueltos =
          g.pagados +
          g.noConvertidos;

        const promedio =
          g.tiemposConversion.length
            ? g.tiemposConversion.reduce(
                (a, b) => a + b,
                0
              ) /
              g.tiemposConversion.length
            : null;

        const medianaGateway =
          mediana(
            g.tiemposConversion
          );

        resumenPasarelas.push({
          mes_key: mesKey,

          mes: nombreMes(mesKey),

          gateway,

          pending_total:
            g.total,

          participacion_pending_mes_pct:
            redondear(
              pct(
                g.total,
                m.pendingTotal
              )
            ),

          pagados:
            g.pagados,

          no_convertidos:
            g.noConvertidos,

          abiertos:
            g.pendientes,

          resueltos,

          conversion_pct:
            redondear(
              pct(
                g.pagados,
                resueltos
              )
            ),

          venta_recuperada:
            redondear(
              g.ventaRecuperada
            ),

          valor_no_convertido:
            redondear(
              g.valorNoConvertido
            ),

          valor_pendiente:
            redondear(
              g.valorPendiente
            ),

          tiempo_promedio_pago_min:
            promedio !== null
              ? redondear(
                  promedio,
                  1
                )
              : "",

          tiempo_mediana_pago_min:
            medianaGateway !== null
              ? redondear(
                  medianaGateway,
                  1
                )
              : "",
        });
      }
    }

    // ==================================================
    // ORDENAR DETALLE
    // ==================================================

    detallePending.sort(
      (a, b) =>
        new Date(a.fecha_creacion) -
        new Date(b.fecha_creacion)
    );

    // ==================================================
    // CREAR CARPETA
    // ==================================================

    fs.mkdirSync("dashboard-data", {
      recursive: true,
    });

    // ==================================================
    // GUARDAR CSV
    // ==================================================

    fs.writeFileSync(
      "dashboard-data/Resumen_Mensual.csv",
      crearCSV(resumenMensual),
      "utf8"
    );

    fs.writeFileSync(
      "dashboard-data/Detalle_Pending.csv",
      crearCSV(detallePending),
      "utf8"
    );

    fs.writeFileSync(
      "dashboard-data/Pasarelas.csv",
      crearCSV(resumenPasarelas),
      "utf8"
    );

    // ==================================================
    // RESUMEN EN TERMINAL
    // ==================================================

    console.log(
      "\n=============================================="
    );

    console.log(
      "✅ ARCHIVOS GENERADOS"
    );

    console.log(
      "==============================================\n"
    );

    console.log(
      "dashboard-data/Resumen_Mensual.csv"
    );

    console.log(
      "dashboard-data/Detalle_Pending.csv"
    );

    console.log(
      "dashboard-data/Pasarelas.csv"
    );

    console.log("");

    console.log(
      `Meses: ${resumenMensual.length}`
    );

    console.log(
      `Pedidos PENDING: ${detallePending.length}`
    );

    console.log(
      `Filas pasarela/mes: ${resumenPasarelas.length}`
    );

    console.log(
      "\n=============================================="
    );

    console.log(
      "📅 RESUMEN MENSUAL"
    );

    console.log(
      "==============================================\n"
    );

    for (const fila of resumenMensual) {
      console.log(
        `${fila.mes.padEnd(
          12
        )} | Pedidos: ${String(
          fila.pedidos_totales
        ).padStart(
          3
        )} | Pending: ${String(
          fila.pending_total
        ).padStart(
          2
        )} | Incidencia: ${String(
          fila.incidencia_pending_pct
        ).padStart(
          5
        )}% | Conversión: ${String(
          fila.conversion_pending_pct
        ).padStart(
          5
        )}%`
      );
    }

    console.log(
      "\n✅ Exportación terminada."
    );
  }

  main().catch((error) => {
    console.error(
      "❌ Error:",
      error
    );

    process.exit(1);
  });