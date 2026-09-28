/**
 * Utilidades de fecha para DATETIME naive de MySQL (sin reinterpretar por TZ).
 */

/** "YYYY-MM-DD HH:mm:ss" → Date con esos componentes en hora local del proceso */
function mysqlDateTimeToLocalDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    let str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str = str + ' 00:00:00';
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

module.exports = { mysqlDateTimeToLocalDate };
