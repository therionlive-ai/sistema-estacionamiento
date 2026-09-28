const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];

    if (!bearerHeader) {
        return res.status(401).json({
            success: false,
            message: 'No se proporcionó token de acceso'
        });
    }

    try {
        const bearer = bearerHeader.split(' ');

        if (bearer.length !== 2 || bearer[0] !== 'Bearer') {
            return res.status(401).json({
                success: false,
                message: 'Formato de token inválido'
            });
        }

        const token = bearer[1];

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        /*
         * Compatibilidad:
         * El JWT actual utiliza "id" como identificador
         * del usuario. El resto del sistema utiliza
         * "id_usuario".
         *
         * Normalizamos ambos nombres para que los módulos
         * nuevos de auditoría puedan utilizar id_usuario
         * sin romper módulos existentes que utilizan id.
         */
        req.user = {
            ...decoded,
            id_usuario: decoded.id_usuario ?? decoded.id
        };

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message: 'Token inválido o expirado'
        });
    }
};


module.exports = verifyToken;
