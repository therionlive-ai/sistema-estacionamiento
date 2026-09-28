const pool = require('../config/db');

function dinero(valor) {
    return Number(Number(valor || 0).toFixed(2));
}

/**
 * Obtiene el convenio solicitado y valida que pertenezca
 * al establecimiento del usuario.
 */
async function obtenerConvenio(idEmpresa, idConvenio) {
    if (!idConvenio) return null;

    const [rows] = await pool.query(
        `SELECT *
         FROM convenios
         WHERE id_convenio = ?
           AND id_empresa = ?
           AND activo = TRUE
         LIMIT 1`,
        [idConvenio, idEmpresa]
    );

    return rows[0] || null;
}

/**
 * Valida fechas de vigencia del convenio.
 */
function validarVigencia(convenio, fecha = new Date()) {
    const hoy =
        `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;

    if (convenio.fecha_inicio && hoy < String(convenio.fecha_inicio).slice(0, 10)) {
        return {
            valido: false,
            mensaje: 'El convenio todavía no está vigente'
        };
    }

    if (convenio.fecha_fin && hoy > String(convenio.fecha_fin).slice(0, 10)) {
        return {
            valido: false,
            mensaje: 'El convenio ya no está vigente'
        };
    }

    return { valido: true };
}

/**
 * Valida el horario configurado en el convenio.
 *
 * Se utiliza principalmente para el gimnasio CECOPAK:
 * 05:00 - 08:00.
 */
function validarHorario(convenio, fecha = new Date()) {
    if (!convenio.hora_desde || !convenio.hora_hasta) {
        return { valido: true };
    }

    const horaActual =
        `${String(fecha.getHours()).padStart(2, '0')}:` +
        `${String(fecha.getMinutes()).padStart(2, '0')}:00`;

    const desde = String(convenio.hora_desde).substring(0, 8);
    const hasta = String(convenio.hora_hasta).substring(0, 8);

    if (desde <= hasta) {
        if (horaActual < desde || horaActual > hasta) {
            return {
                valido: false,
                mensaje: `El convenio solamente aplica entre ${desde.substring(0, 5)} y ${hasta.substring(0, 5)}`
            };
        }
    } else {
        // Horario que cruza medianoche.
        if (horaActual > hasta && horaActual < desde) {
            return {
                valido: false,
                mensaje: `El convenio solamente aplica entre ${desde.substring(0, 5)} y ${hasta.substring(0, 5)}`
            };
        }
    }

    return { valido: true };
}

/**
 * Cuenta cuántas veces se utilizó un convenio
 * durante el período correspondiente.
 *
 * Para tiendas:
 *   usos_por_periodo = 1
 *   periodicidad_uso = diario
 *
 * significa una cortesía por día por tienda.
 */
async function contarUsosConvenio(conn, convenio, fechaReferencia = new Date()) {
    if (!convenio.usos_por_periodo || convenio.usos_por_periodo <= 0) {
        return 0;
    }

    let condicionFecha = '';
    let parametros = [
        convenio.id_empresa,
        convenio.id_convenio
    ];

    if (convenio.periodicidad_uso === 'diario') {
        condicionFecha = 'AND DATE(mc.fecha_aplicacion) = DATE(?)';
        parametros.push(fechaReferencia);
    } else if (convenio.periodicidad_uso === 'semanal') {
        condicionFecha = `
            AND YEARWEEK(mc.fecha_aplicacion, 1) =
                YEARWEEK(?, 1)
        `;
        parametros.push(fechaReferencia);
    } else if (convenio.periodicidad_uso === 'mensual') {
        condicionFecha = `
            AND YEAR(mc.fecha_aplicacion) = YEAR(?)
            AND MONTH(mc.fecha_aplicacion) = MONTH(?)
        `;
        parametros.push(fechaReferencia, fechaReferencia);
    }

    const [rows] = await conn.query(
        `SELECT COUNT(*) AS usos
         FROM movimientos_convenios mc
         WHERE mc.id_empresa = ?
           AND mc.id_convenio = ?
           ${condicionFecha}`,
        parametros
    );

    return Number(rows[0]?.usos || 0);
}

/**
 * Valida un convenio para una salida.
 *
 * Importante:
 * La cortesía general de <15 minutos NO entra aquí.
 * Esa cortesía se determina automáticamente por el sistema.
 */
async function validarConvenio({
    conn,
    idEmpresa,
    idConvenio,
    referenciaBeneficio = null,
    fecha = new Date(),
    fechaHorario = fecha
}) {
    const convenio = await obtenerConvenio(idEmpresa, idConvenio);

    if (!convenio) {
        return {
            valido: false,
            mensaje: 'Convenio no encontrado, inactivo o no pertenece al establecimiento'
        };
    }

    if (convenio.tipo_beneficiario === 'sistema') {
        return {
            valido: false,
            mensaje: 'Este convenio es administrado automáticamente por el sistema'
        };
    }

    const vigencia = validarVigencia(convenio, fecha);

    if (!vigencia.valido) {
        return vigencia;
    }

    const horario = validarHorario(convenio, fechaHorario);

    if (!horario.valido) {
        return horario;
    }

    if (convenio.requiere_sello && !String(referenciaBeneficio || '').trim()) {
        return {
            valido: false,
            mensaje: 'Este convenio requiere sello o referencia autorizada'
        };
    }

    if (
        convenio.usos_por_periodo > 0 &&
        convenio.periodicidad_uso !== 'ninguno'
    ) {
        const usos = await contarUsosConvenio(conn, convenio, fecha);

        if (usos >= convenio.usos_por_periodo) {
            return {
                valido: false,
                mensaje: `El convenio ya alcanzó su límite de ${convenio.usos_por_periodo} uso(s) en el período establecido`
            };
        }
    }

    return {
        valido: true,
        convenio
    };
}

/**
 * Calcula el beneficio sobre el total normal.
 *
 * reglas:
 *
 * vehiculo_gratis:
 *     todo el estacionamiento queda en cortesía.
 *
 * horas_gratis:
 *     las primeras N horas son gratuitas.
 *
 * porcentaje:
 *     descuento porcentual.
 *
 * monto:
 *     descuento monetario.
 *
 * tarifa_especial / indefinido_horario:
 *     se dejan para la siguiente etapa de reglas específicas.
 */
function calcularBeneficio({
    minutos,
    totalNormal,
    convenio
}) {
    const minutosTotales = Math.max(0, Number(minutos || 0));
    const original = dinero(totalNormal);

    if (!convenio) {
        return {
            minutosGratis: 0,
            descuento: 0,
            totalFinal: original,
            motivo: null
        };
    }

    let minutosGratis = 0;
    let descuento = 0;
    let totalFinal = original;
    let motivo = convenio.codigo || convenio.nombre;

    if (convenio.tipo_beneficio === 'vehiculo_gratis') {
        minutosGratis = minutosTotales;
        descuento = original;
        totalFinal = 0;
    }

    else if (convenio.tipo_beneficio === 'horas_gratis') {
        const horasGratis = Math.max(0, Number(convenio.valor_beneficio || 0));
        minutosGratis = Math.min(
            minutosTotales,
            Math.round(horasGratis * 60)
        );

        /*
         * El descuento monetario exacto por horas gratis
         * se determina posteriormente utilizando la tarifa.
         * Aquí dejamos el valor disponible para que movimientos.js
         * pueda recalcular la parte facturable.
         */
    }

    else if (convenio.tipo_beneficio === 'porcentaje') {
        const porcentaje = Math.min(
            100,
            Math.max(0, Number(convenio.valor_beneficio || 0))
        );

        descuento = dinero(original * (porcentaje / 100));
        totalFinal = dinero(original - descuento);
    }

    else if (convenio.tipo_beneficio === 'monto') {
        descuento = Math.min(
            original,
            Math.max(0, Number(convenio.valor_beneficio || 0))
        );

        totalFinal = dinero(original - descuento);
    }

    return {
        minutosGratis,
        descuento: dinero(descuento),
        totalFinal: dinero(totalFinal),
        motivo
    };
}


/**
 * Registra el beneficio aplicado al movimiento.
 * Se ejecuta dentro de la misma transacción que finaliza la salida.
 */
async function registrarBeneficio({
    conn,
    idEmpresa,
    idMovimiento,
    idConvenio,
    minutosGratis = 0,
    descuento = 0,
    totalOriginal = 0,
    totalFinal = 0,
    motivo = null,
    referenciaBeneficio = null,
    aplicadoPor
}) {
    if (!idConvenio) {
        return null;
    }

    const [result] = await conn.query(
        `INSERT INTO movimientos_convenios
        (
            id_empresa,
            id_movimiento,
            id_convenio,
            minutos_gratis,
            descuento,
            total_original,
            total_final,
            motivo,
            referencia_beneficio,
            aplicado_por
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            idEmpresa,
            idMovimiento,
            idConvenio,
            Math.max(0, Number(minutosGratis || 0)),
            dinero(descuento),
            dinero(totalOriginal),
            dinero(totalFinal),
            motivo,
            referenciaBeneficio || null,
            aplicadoPor
        ]
    );

    return result.insertId;
}

module.exports = {
    dinero,
    obtenerConvenio,
    validarVigencia,
    validarHorario,
    contarUsosConvenio,
    validarConvenio,
    calcularBeneficio
};
