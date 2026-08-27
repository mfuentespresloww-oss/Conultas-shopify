import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { google } from "googleapis";

const SPREADSHEET_ID =
  "1Z5okxtAXL5DZ7zfgeztZv_PTdGqAY-KDhf5AN7AonFk";

const ARCHIVOS = [
  {
    tab: "Resumen_Mensual",
    archivo: "./dashboard-data/Resumen_Mensual.csv",
  },
  {
    tab: "Detalle_Pending",
    archivo: "./dashboard-data/Detalle_Pending.csv",
  },
  {
    tab: "Pasarelas",
    archivo: "./dashboard-data/Pasarelas.csv",
  },
];

function convertirValor(valor) {
  if (valor === "") return "";

  // Convierte números reales a número para que
  // Google Sheets y Looker Studio los reconozcan correctamente.
  if (/^-?\d+(\.\d+)?$/.test(valor)) {
    return Number(valor);
  }

  return valor;
}

function leerCSV(ruta) {
  if (!fs.existsSync(ruta)) {
    throw new Error(`No existe el archivo: ${ruta}`);
  }

  const contenido = fs.readFileSync(ruta, "utf8");

  const filas = parse(contenido, {
    bom: true,
    skip_empty_lines: true,
  });

  return filas.map((fila) =>
    fila.map(convertirValor)
  );
}

async function main() {
  console.log(
    "\n📤 SUBIENDO DASHBOARD A GOOGLE SHEETS...\n"
  );

  // ==================================================
  // AUTENTICACIÓN GOOGLE
  // ==================================================

  let auth;

  // En GitHub Actions usaremos el secreto:
  // GOOGLE_SERVICE_ACCOUNT_JSON
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log(
      "🔐 Usando credenciales desde variable de entorno"
    );

    const credentials = JSON.parse(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    );

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
  } else {
    // En Codespace/local usamos el archivo JSON
    console.log(
      "🔐 Usando google-service-account.json"
    );

    if (
      !fs.existsSync(
        "./google-service-account.json"
      )
    ) {
      throw new Error(
        "No existe google-service-account.json y tampoco está definida GOOGLE_SERVICE_ACCOUNT_JSON"
      );
    }

    auth = new google.auth.GoogleAuth({
      keyFile:
        "./google-service-account.json",
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });
  }

  // Crear cliente de Google Sheets
  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  // ==================================================
  // LEER CSV
  // ==================================================

  const tablas = ARCHIVOS.map(
    (item) => ({
      ...item,
      filas: leerCSV(item.archivo),
    })
  );

  console.log("\nArchivos leídos:");

  for (const tabla of tablas) {
    console.log(
      `- ${tabla.tab}: ${
        tabla.filas.length - 1
      } filas`
    );
  }

  // ==================================================
  // VERIFICAR PESTAÑAS
  // ==================================================

  const metadata =
    await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
    });

  const pestañas = new Map(
    metadata.data.sheets.map((sheet) => [
      sheet.properties.title,
      sheet.properties.sheetId,
    ])
  );

  for (const tabla of tablas) {
    if (!pestañas.has(tabla.tab)) {
      throw new Error(
        `No existe la pestaña "${tabla.tab}" en Google Sheets`
      );
    }
  }

  // ==================================================
  // LIMPIAR DATOS ANTERIORES
  // ==================================================

  console.log(
    "\nLimpiando datos anteriores..."
  );

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      ranges: tablas.map(
        (tabla) =>
          `'${tabla.tab}'!A:Z`
      ),
    },
  });

  // ==================================================
  // ESCRIBIR DATOS NUEVOS
  // ==================================================

  console.log(
    "Escribiendo datos nuevos..."
  );

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",

      data: tablas.map(
        (tabla) => ({
          range: `'${tabla.tab}'!A1`,
          majorDimension: "ROWS",
          values: tabla.filas,
        })
      ),
    },
  });

  // ==================================================
  // FORMATO
  // ==================================================

  const requests = [];

  for (const tabla of tablas) {
    const sheetId =
      pestañas.get(tabla.tab);

    const columnas =
      tabla.filas[0].length;

    // Encabezado en negritas
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: columnas,
        },

        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true,
            },
          },
        },

        fields:
          "userEnteredFormat.textFormat.bold",
      },
    });

    // Congelar encabezado
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,

          gridProperties: {
            frozenRowCount: 1,
          },
        },

        fields:
          "gridProperties.frozenRowCount",
      },
    });
  }

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,

      requestBody: {
        requests,
      },
    });
  }

  // ==================================================
  // VERIFICACIÓN
  // ==================================================

  console.log(
    "\n✅ GOOGLE SHEETS ACTUALIZADO\n"
  );

  for (const tabla of tablas) {
    console.log(
      `${tabla.tab}: ${
        tabla.filas.length - 1
      } registros`
    );
  }

  console.log(
    "\nhttps://docs.google.com/spreadsheets/d/" +
      SPREADSHEET_ID +
      "/edit"
  );
}

main().catch((error) => {
  console.error("\n❌ ERROR:");

  if (
    error?.response?.data
  ) {
    console.dir(
      error.response.data,
      {
        depth: null,
      }
    );
  } else {
    console.error(
      error?.message ||
        error
    );
  }

  process.exit(1);
});