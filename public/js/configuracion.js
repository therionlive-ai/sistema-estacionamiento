// Configuración de empresa (admin)
// Relacionado con: public/admin/configuracion.html y API /api/empresa

document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('token');
    const role = localStorage.getItem('userRole');
    if (!token) { window.location.href = '/'; return; }
    if (role !== 'admin') { window.location.href = '/admin/dashboard'; return; }

    document.getElementById('userName').textContent = localStorage.getItem('userName') || 'Usuario';
    document.querySelector('.sidebar-toggle').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('show'));
    document.getElementById('btnLogout').addEventListener('click',()=>{ localStorage.clear(); location.href='/'; });

    // Cargar datos
    cargarEmpresa();
    cargarConfig();

    // Guardar
    document.getElementById('btnSaveEmpresa').addEventListener('click', guardarEmpresa);
    document.getElementById('btnSaveConfig').addEventListener('click', guardarConfig);

    const btnDetectTz = document.getElementById('btnDetectTz');
    if (btnDetectTz) {
        btnDetectTz.addEventListener('click', detectarZonaHoraria);
    }

    // Logo: vista previa y subida
    const fileInput = document.getElementById('e_logo_file');
    const preview = document.getElementById('e_logo_preview');
    const uploadBtn = document.getElementById('btnUploadLogo');
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const f = fileInput.files && fileInput.files[0];
            if (!f) { preview.src=''; preview.classList.add('d-none'); return; }
            // Validar tamaño (<= 2MB) y tipo (PNG/JPG/GIF)
            const max = 2 * 1024 * 1024;
            const okType = ['image/png','image/jpeg','image/jpg','image/gif'].includes(f.type);
            if (!okType) { setAlert('alertEmpresa','danger','Tipo de archivo no permitido. Usa PNG/JPG.'); fileInput.value=''; return; }
            if (f.size > max) { setAlert('alertEmpresa','danger','El archivo excede 2MB.'); fileInput.value=''; return; }
            const reader = new FileReader();
            reader.onload = e => { preview.src = e.target.result; preview.classList.remove('d-none'); };
            reader.readAsDataURL(f);
        });
    }
    if (uploadBtn) {
        uploadBtn.addEventListener('click', subirLogo);
    }
});

async function cargarEmpresa(){
    try{
        const r = await fetch('/api/empresa/me',{ headers:{ 'Authorization':`Bearer ${localStorage.getItem('token')}` }});
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error cargando empresa');
        const e = j.data;
        document.getElementById('e_nombre').value = e.nombre || '';
        document.getElementById('e_nit').value = e.nit || '';
        document.getElementById('e_direccion').value = e.direccion || '';
        document.getElementById('e_telefono').value = e.telefono || '';
        document.getElementById('e_email').value = e.email || '';
        const preview = document.getElementById('e_logo_preview');
        if (preview) {
            // Intentar cargar desde endpoint BLOB; si 404, ocultar
            fetch('/api/empresa/logo', { headers:{'Authorization':`Bearer ${localStorage.getItem('token')}`} })
                .then(r=> r.ok ? r.blob() : Promise.reject())
                .then(b=>{ preview.src = URL.createObjectURL(b); preview.classList.remove('d-none'); })
                .catch(()=> preview.classList.add('d-none'));
        }
    }catch(err){ setAlert('alertEmpresa', 'danger', err.message); }
}

// Función para cargar configuración de empresa
// Relacionado con: src/routes/empresa.js GET /api/empresa/config
// Nota: Las capacidades ya no se cargan aquí, se gestionan desde Tipos de Vehículos
async function cargarConfig(){
    try{
        const r = await fetch('/api/empresa/config',{ headers:{ 'Authorization':`Bearer ${localStorage.getItem('token')}` }});
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error cargando configuración');
        const c = j.data;
        // Las capacidades ya no se cargan, se gestionan desde tipos-vehiculos.html
        document.getElementById('c_apertura').value = (c.horario_apertura||'').toString().substring(0,5);
        document.getElementById('c_cierre').value = (c.horario_cierre||'').toString().substring(0,5);
        document.getElementById('c_iva').value = c.iva_porcentaje ?? 0;
        document.getElementById('c_moneda').value = c.moneda || 'HNL';
        setSelectZona(c.zona_horaria || 'America/Tegucigalpa');
        if (window.EmpresaDateTime) {
            window.EmpresaDateTime.setEmpresaTimezone(c.zona_horaria, c.moneda);
        }
        const chk = document.getElementById('c_24h');
        if (chk) {
            chk.checked = !!c.operacion_24h;
            toggleHorasPor24h();
            chk.addEventListener('change', toggleHorasPor24h);
        }
    }catch(err){ setAlert('alertConfig', 'danger', err.message); }
}

async function guardarEmpresa(){
    const payload = {
        nombre: document.getElementById('e_nombre').value.trim(),
        nit: document.getElementById('e_nit').value.trim(),
        direccion: document.getElementById('e_direccion').value.trim(),
        telefono: document.getElementById('e_telefono').value.trim(),
        email: document.getElementById('e_email').value.trim()
    };
    const btn = document.getElementById('btnSaveEmpresa');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Guardando...');
    try{
        const r = await fetch('/api/empresa',{
            method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('token')}`}, body: JSON.stringify(payload)
        });
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error al guardar');
        setAlert('alertEmpresa', 'success', 'Datos de empresa actualizados.');
    }catch(err){ setAlert('alertEmpresa','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}

// Función para guardar configuración de empresa
// Relacionado con: src/routes/empresa.js PUT /api/empresa/config
// Nota: Las capacidades ya no se envían aquí, se gestionan desde tipos-vehiculos.html
async function guardarConfig(){
    const payload = {
        // Las capacidades ya no se envían, se gestionan desde el panel de Tipos de Vehículos
        horario_apertura: document.getElementById('c_apertura').value,
        horario_cierre: document.getElementById('c_cierre').value,
        iva_porcentaje: Number(document.getElementById('c_iva').value||0),
        moneda: document.getElementById('c_moneda').value.trim()||'HNL',
        zona_horaria: document.getElementById('c_tz').value.trim()||'America/Tegucigalpa',
        operacion_24h: document.getElementById('c_24h').checked
    };
    const btn = document.getElementById('btnSaveConfig');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Guardando...');
    try{
        const r = await fetch('/api/empresa/config',{
            method:'PUT', headers:{'Content-Type':'application/json','Authorization':`Bearer ${localStorage.getItem('token')}`}, body: JSON.stringify(payload)
        });
        const j = await r.json();
        if(!r.ok) throw new Error(j.message||'Error al guardar');
        if (window.EmpresaDateTime) {
            window.EmpresaDateTime.setEmpresaTimezone(payload.zona_horaria, payload.moneda);
        }
        setAlert('alertConfig', 'success', 'Configuración actualizada.');
    }catch(err){ setAlert('alertConfig','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}

function setSelectZona(zona){
    const sel = document.getElementById('c_tz');
    if (!sel) return;
    const value = (zona || 'America/Tegucigalpa').trim();
    let found = false;
    for (const opt of sel.options) {
        if (opt.value === value) { found = true; break; }
    }
    if (!found) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value + ' (personalizada)';
        sel.appendChild(opt);
    }
    sel.value = value;
}

function detectarZonaHoraria(){
    setSelectZona('America/Tegucigalpa');
    setAlert('alertConfig', 'info', 'La zona horaria de LKCO está fijada en America/Tegucigalpa.');
}

function toggleHorasPor24h(){
    const on = document.getElementById('c_24h').checked;
    document.getElementById('c_apertura').disabled = on;
    document.getElementById('c_cierre').disabled = on;
}

function setAlert(id, type, msg){
    const el = document.getElementById(id);
    el.className = `alert alert-${type}`;
    el.textContent = msg;
}

function spinner(text){
    return `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> ${text}`;
}

// Subir logo y colocar URL pública en el campo de texto (no guarda aún en BD)
async function subirLogo(){
    const file = document.getElementById('e_logo_file') && document.getElementById('e_logo_file').files[0];
    if (!file) { setAlert('alertEmpresa','warning','Selecciona un archivo de logo.'); return; }
    const btn = document.getElementById('btnUploadLogo');
    const prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = spinner('Subiendo...');
    try{
        const form = new FormData();
        form.append('logo', file);
        const r = await fetch('/api/empresa/logo', { method:'POST', headers:{ 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: form });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message||'Error al subir logo');
        if (preview) { preview.src = j.url; preview.classList.remove('d-none'); }
        setAlert('alertEmpresa','success','Logo subido y guardado.');
    }catch(err){ setAlert('alertEmpresa','danger', err.message); }
    finally{ btn.disabled=false; btn.innerHTML = prev; }
}


