const express = require('express');
const multer = require('multer');
const router = express.Router();
const pool = require('../config/db');
const auth = require('../middleware/auth');
const requireRoles = require('../middleware/requireRoles');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

router.use(auth);

/**
 * Obtiene la IP real de origen de la solicitud.
 */
function obtenerIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

/**
 * Convierte un objeto a JSON seguro para auditoría.
 */
function jsonSeguro(valor) {
  if (valor === null || valor === undefined) {
    return null;
  }

  return JSON.stringify(valor);
}

/**
 * Registra una acción en auditoria_fiscal.
 */
async function registrarAuditoria({
  req,
  entidad,
  idReferencia = null,
  accion,
  datosAnteriores = null,
  datosNuevos = null
}) {
  await pool.query(
    `INSERT INTO auditoria_fiscal (
      id_empresa,
      id_usuario,
      nombre_usuario,
      rol_usuario,
      modulo,
      entidad,
      id_referencia,
      accion,
      datos_anteriores,
      datos_nuevos,
      ip_origen
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      req.user.id_empresa,
      req.user.id_usuario,
      req.user.nombre || req.user.usuario_login || 'Usuario',
      req.user.rol,
      'fiscal',
      entidad,
      idReferencia,
      accion,
      jsonSeguro(datosAnteriores),
      jsonSeguro(datosNuevos),
      obtenerIP(req)
    ]
  );
}

/**
 * Campos que forman parte del snapshot del Registro Tributario.
 */
function snapshotRegistro(row) {
  if (!row) return null;

  return {
    id_registro: row.id_registro,
    id_empresa: row.id_empresa,
    rtn: row.rtn,
    razon_social: row.razon_social,
    nombre_comercial: row.nombre_comercial,
    direccion_fiscal: row.direccion_fiscal,
    actividad_economica: row.actividad_economica,
    cai: row.cai,
    fecha_vencimiento_cai: row.fecha_vencimiento_cai,
    estado: row.estado,
    observaciones: row.observaciones
  };
}

/**
 * Campos de una secuencia fiscal para auditoría.
 */
function snapshotSecuencia(row) {
  if (!row) return null;

  return {
    id_secuencia: row.id_secuencia,
    id_empresa: row.id_empresa,
    tipo_documento: row.tipo_documento,
    prefijo: row.prefijo,
    rango_desde: row.rango_desde,
    rango_hasta: row.rango_hasta,
    correlativo_actual: row.correlativo_actual,
    activa: row.activa,
    fecha_vigencia_desde: row.fecha_vigencia_desde,
    fecha_vigencia_hasta: row.fecha_vigencia_hasta
  };
}

/**
 * Consulta la configuración fiscal del establecimiento actual.
 */
router.get('/', requireRoles('admin', 'operador'), async (req, res) => {
  try {
    const [registro] = await pool.query(
      `SELECT *
       FROM registros_tributarios
       WHERE id_empresa=?
       LIMIT 1`,
      [req.user.id_empresa]
    );

    const [secuencias] = await pool.query(
      `SELECT *
       FROM secuencias_fiscales
       WHERE id_empresa=?
       ORDER BY tipo_documento`,
      [req.user.id_empresa]
    );

    const [archivos] = await pool.query(
      `SELECT
          id_archivo,
          nombre_archivo,
          mime_type,
          fecha_carga,
          activo
       FROM registros_tributarios_archivos
       WHERE id_empresa=?
         AND activo=TRUE
       ORDER BY fecha_carga DESC`,
      [req.user.id_empresa]
    );

    res.json({
      success: true,
      data: {
        registro: registro[0] || null,
        secuencias,
        archivos
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo configuración tributaria'
    });
  }
});

/**
 * Crear o modificar Registro Tributario.
 */
router.put(
  '/registro',
  requireRoles('admin', 'operador'),
  async (req, res) => {
    try {
      const {
        rtn,
        razon_social,
        nombre_comercial,
        direccion_fiscal,
        actividad_economica,
        cai,
        fecha_vencimiento_cai,
        estado,
        observaciones
      } = req.body;

      if (!rtn || !razon_social) {
        return res.status(400).json({
          success: false,
          message: 'RTN y razón social son obligatorios'
        });
      }

      const [existente] = await pool.query(
        `SELECT *
         FROM registros_tributarios
         WHERE id_empresa=?
         LIMIT 1`,
        [req.user.id_empresa]
      );

      const anterior = existente.length
        ? snapshotRegistro(existente[0])
        : null;

      await pool.query(
        `INSERT INTO registros_tributarios (
          id_empresa,
          rtn,
          razon_social,
          nombre_comercial,
          direccion_fiscal,
          actividad_economica,
          cai,
          fecha_vencimiento_cai,
          estado,
          observaciones
        )
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          rtn=VALUES(rtn),
          razon_social=VALUES(razon_social),
          nombre_comercial=VALUES(nombre_comercial),
          direccion_fiscal=VALUES(direccion_fiscal),
          actividad_economica=VALUES(actividad_economica),
          cai=VALUES(cai),
          fecha_vencimiento_cai=VALUES(fecha_vencimiento_cai),
          estado=VALUES(estado),
          observaciones=VALUES(observaciones)`,
        [
          req.user.id_empresa,
          rtn,
          razon_social,
          nombre_comercial || null,
          direccion_fiscal || null,
          actividad_economica || null,
          cai || null,
          fecha_vencimiento_cai || null,
          estado || 'pendiente',
          observaciones || null
        ]
      );

      const [actualizado] = await pool.query(
        `SELECT *
         FROM registros_tributarios
         WHERE id_empresa=?
         LIMIT 1`,
        [req.user.id_empresa]
      );

      const nuevo = actualizado.length
        ? snapshotRegistro(actualizado[0])
        : null;

      const anteriorTexto = jsonSeguro(anterior);
      const nuevoTexto = jsonSeguro(nuevo);

      if (anteriorTexto !== nuevoTexto) {
        await registrarAuditoria({
          req,
          entidad: 'registro_tributario',
          idReferencia: nuevo?.id_registro || null,
          accion: anterior ? 'modificar' : 'crear',
          datosAnteriores: anterior,
          datosNuevos: nuevo
        });
      }

      res.json({
        success: true,
        message: 'Registro tributario guardado'
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({
        success: false,
        message: 'Error guardando registro tributario'
      });
    }
  }
);

/**
 * Carga de documento tributario.
 */
router.post(
  '/archivo',
  requireRoles('admin', 'operador'),
  upload.single('archivo'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Archivo no recibido'
        });
      }

      const [r] = await pool.query(
        `SELECT id_registro
         FROM registros_tributarios
         WHERE id_empresa=?
         LIMIT 1`,
        [req.user.id_empresa]
      );

      if (!r.length) {
        return res.status(400).json({
          success: false,
          message: 'Primero configure el registro tributario'
        });
      }

      const [resultado] = await pool.query(
        `INSERT INTO registros_tributarios_archivos (
          id_empresa,
          id_registro,
          nombre_archivo,
          mime_type,
          contenido
        )
        VALUES (?,?,?,?,?)`,
        [
          req.user.id_empresa,
          r[0].id_registro,
          req.file.originalname,
          req.file.mimetype,
          req.file.buffer
        ]
      );

      await registrarAuditoria({
        req,
        entidad: 'archivo_fiscal',
        idReferencia: resultado.insertId,
        accion: 'subir_archivo',
        datosAnteriores: null,
        datosNuevos: {
          id_archivo: resultado.insertId,
          id_registro: r[0].id_registro,
          nombre_archivo: req.file.originalname,
          mime_type: req.file.mimetype,
          tamano_bytes: req.file.size
        }
      });

      res.json({
        success: true,
        message: 'Archivo tributario guardado'
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({
        success: false,
        message: 'Error guardando archivo tributario'
      });
    }
  }
);

/**
 * Consulta de archivo tributario.
 */
router.get(
  '/archivo/:id',
  requireRoles('admin', 'operador'),
  async (req, res) => {
    try {
      const [r] = await pool.query(
        `SELECT
            nombre_archivo,
            mime_type,
            contenido
         FROM registros_tributarios_archivos
         WHERE id_archivo=?
           AND id_empresa=?
           AND activo=TRUE`,
        [req.params.id, req.user.id_empresa]
      );

      if (!r.length) {
        return res.status(404).json({
          success: false,
          message: 'Archivo no encontrado'
        });
      }

      res.setHeader('Content-Type', r[0].mime_type);
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${r[0].nombre_archivo.replace(/"/g, '')}"`
      );

      res.send(r[0].contenido);
    } catch (e) {
      res.status(500).json({
        success: false,
        message: 'Error descargando archivo'
      });
    }
  }
);

/**
 * Crear o actualizar secuencia fiscal.
 */
router.post(
  '/secuencias',
  requireRoles('admin', 'operador'),
  async (req, res) => {
    try {
      const {
        tipo_documento,
        prefijo,
        rango_desde,
        rango_hasta,
        correlativo_actual,
        activa,
        fecha_vigencia_desde,
        fecha_vigencia_hasta
      } = req.body;

      if (
        !tipo_documento ||
        rango_desde == null ||
        rango_hasta == null
      ) {
        return res.status(400).json({
          success: false,
          message: 'Tipo y rango son obligatorios'
        });
      }

      if (Number(rango_hasta) < Number(rango_desde)) {
        return res.status(400).json({
          success: false,
          message: 'El rango final no puede ser menor al inicial'
        });
      }

      const [existente] = await pool.query(
        `SELECT *
         FROM secuencias_fiscales
         WHERE id_empresa=?
           AND tipo_documento=?
         LIMIT 1`,
        [
          req.user.id_empresa,
          tipo_documento
        ]
      );

      const anterior = existente.length
        ? snapshotSecuencia(existente[0])
        : null;

      await pool.query(
        `INSERT INTO secuencias_fiscales (
          id_empresa,
          tipo_documento,
          prefijo,
          rango_desde,
          rango_hasta,
          correlativo_actual,
          activa,
          fecha_vigencia_desde,
          fecha_vigencia_hasta
        )
        VALUES (?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          prefijo=VALUES(prefijo),
          rango_desde=VALUES(rango_desde),
          rango_hasta=VALUES(rango_hasta),
          correlativo_actual=VALUES(correlativo_actual),
          activa=VALUES(activa),
          fecha_vigencia_desde=VALUES(fecha_vigencia_desde),
          fecha_vigencia_hasta=VALUES(fecha_vigencia_hasta)`,
        [
          req.user.id_empresa,
          tipo_documento,
          prefijo || '',
          Number(rango_desde),
          Number(rango_hasta),
          Number(correlativo_actual || 0),
          activa !== false,
          fecha_vigencia_desde || null,
          fecha_vigencia_hasta || null
        ]
      );

      const [actualizada] = await pool.query(
        `SELECT *
         FROM secuencias_fiscales
         WHERE id_empresa=?
           AND tipo_documento=?
         LIMIT 1`,
        [
          req.user.id_empresa,
          tipo_documento
        ]
      );

      const nueva = actualizada.length
        ? snapshotSecuencia(actualizada[0])
        : null;

      const anteriorTexto = jsonSeguro(anterior);
      const nuevoTexto = jsonSeguro(nueva);

      if (anteriorTexto !== nuevoTexto) {
        await registrarAuditoria({
          req,
          entidad: 'secuencia_fiscal',
          idReferencia: nueva?.id_secuencia || null,
          accion: anterior
            ? 'actualizar_secuencia'
            : 'crear',
          datosAnteriores: anterior,
          datosNuevos: nueva
        });
      }

      res.json({
        success: true,
        message: 'Secuencia fiscal guardada'
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({
        success: false,
        message: 'Error guardando secuencia fiscal'
      });
    }
  }
);

module.exports = router;
