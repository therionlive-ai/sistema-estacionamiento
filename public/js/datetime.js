/**
 * Formato de fechas según zona_horaria de la empresa.
 * DATETIME de MySQL se trata como hora de pared en esa zona (sin desfase entre zonas horarias).
 */
(function (global) {
    var STORAGE_TZ = 'empresaZonaHoraria';
    var STORAGE_LOCALE = 'empresaLocale';
    var STORAGE_MONEDA = 'empresaMoneda';
    var DEFAULT_TZ = 'America/Tegucigalpa';
    var DEFAULT_LOCALE = 'es';

    var LOCALE_BY_TZ = {
        'America/Mexico_City': 'es-MX',
        'America/Cancun': 'es-MX',
        'America/Tijuana': 'es-MX',
        'America/Monterrey': 'es-MX',
        'America/Merida': 'es-MX',
        'America/Tegucigalpa': 'es-HN',
        'America/Lima': 'es-PE',
        'America/Guayaquil': 'es-EC',
        'America/Caracas': 'es-VE',
        'America/La_Paz': 'es-BO',
        'America/Santiago': 'es-CL',
        'America/Argentina/Buenos_Aires': 'es-AR',
        'America/Asuncion': 'es-PY',
        'America/Montevideo': 'es-UY',
        'America/Panama': 'es-PA',
        'America/Costa_Rica': 'es-CR',
        'America/Guatemala': 'es-GT',
        'America/El_Salvador': 'es-SV',
        'America/Tegucigalpa': 'es-HN',
        'America/Managua': 'es-NI',
        'America/Santo_Domingo': 'es-DO',
        'America/Havana': 'es-CU',
        'Europe/Madrid': 'es-ES',
        'Atlantic/Canary': 'es-ES'
    };

    function getZonaHoraria() {
        try {
            return localStorage.getItem(STORAGE_TZ) || DEFAULT_TZ;
        } catch (_e) {
            return DEFAULT_TZ;
        }
    }

    function getLocale() {
        try {
            return localStorage.getItem(STORAGE_LOCALE) || DEFAULT_LOCALE;
        } catch (_e) {
            return DEFAULT_LOCALE;
        }
    }

    function localeFromZona(zona) {
        return LOCALE_BY_TZ[zona] || DEFAULT_LOCALE;
    }

    function setEmpresaTimezone(zona, moneda) {
        var tz = (zona && String(zona).trim()) || DEFAULT_TZ;
        var locale = localeFromZona(tz);
        try {
            localStorage.setItem(STORAGE_TZ, tz);
            localStorage.setItem(STORAGE_LOCALE, locale);
            if (moneda) localStorage.setItem(STORAGE_MONEDA, moneda);
        } catch (_e) {}
        return { zona_horaria: tz, locale: locale };
    }

    function partsInTz(ms, timeZone) {
        var fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        var parts = fmt.formatToParts(new Date(ms));
        var get = function (type) {
            var p = parts.find(function (x) { return x.type === type; });
            return p ? Number(p.value) : 0;
        };
        var h = get('hour');
        if (h === 24) h = 0;
        return { y: get('year'), mo: get('month'), d: get('day'), h: h, mi: get('minute'), s: get('second') };
    }

    /** Interpreta "YYYY-MM-DD HH:mm:ss" como hora de pared en timeZone → Date absoluto */
    function wallClockToDate(mysqlStr, timeZone) {
        var m = String(mysqlStr).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return new Date(mysqlStr);
        var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
        var guess = Date.UTC(y, mo - 1, d, h, mi, s);
        for (var i = 0; i < 3; i++) {
            var p = partsInTz(guess, timeZone);
            var asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
            var wanted = Date.UTC(y, mo - 1, d, h, mi, s);
            guess += wanted - asUtc;
        }
        return new Date(guess);
    }

    function toDate(value, timeZone) {
        if (value == null || value === '') return null;
        if (value instanceof Date) return value;
        var str = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
            str = str + ' 00:00:00';
        }
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(str)) {
            return wallClockToDate(str, timeZone || getZonaHoraria());
        }
        var d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    function formatEmpresaDateTime(value, options) {
        var tz = getZonaHoraria();
        var locale = getLocale();
        var d = (value === undefined || value === 'now') ? new Date() : toDate(value, tz);
        if (!d || isNaN(d.getTime())) return '';
        var opts = Object.assign({ timeZone: tz }, options || {});
        try {
            return d.toLocaleString(locale, opts);
        } catch (_e) {
            return d.toLocaleString(DEFAULT_LOCALE, opts);
        }
    }

    function formatEmpresaTime(value) {
        return formatEmpresaDateTime(value, { hour: '2-digit', minute: '2-digit' });
    }

    function formatEmpresaDate(value) {
        return formatEmpresaDateTime(value, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    /** Carga zona desde API si hay token (y refresca caché) */
    function ensureEmpresaTimezone() {
        var token = null;
        try { token = localStorage.getItem('token'); } catch (_e) {}
        if (!token) return Promise.resolve(getZonaHoraria());

        return fetch('/api/empresa/config', {
            headers: { Authorization: 'Bearer ' + token }
        })
            .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
            .then(function (res) {
                if (!res.ok || !res.j || !res.j.data) return getZonaHoraria();
                setEmpresaTimezone(res.j.data.zona_horaria, res.j.data.moneda);
                return getZonaHoraria();
            })
            .catch(function () { return getZonaHoraria(); });
    }

    // Auto-cargar en páginas autenticadas
    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { ensureEmpresaTimezone(); });
        } else {
            ensureEmpresaTimezone();
        }
    }

    global.EmpresaDateTime = {
        getZonaHoraria: getZonaHoraria,
        getLocale: getLocale,
        setEmpresaTimezone: setEmpresaTimezone,
        ensureEmpresaTimezone: ensureEmpresaTimezone,
        format: formatEmpresaDateTime,
        formatTime: formatEmpresaTime,
        formatDate: formatEmpresaDate,
        toDate: toDate,
        localeFromZona: localeFromZona
    };

    // Atajos globales usados en plantillas
    global.formatEmpresaDateTime = formatEmpresaDateTime;
    global.formatEmpresaTime = formatEmpresaTime;
    global.formatEmpresaDate = formatEmpresaDate;
})(typeof window !== 'undefined' ? window : globalThis);
