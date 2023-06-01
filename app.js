require('dotenv').config();
const express = require('express');
const socket = require('socket.io');



const app = express();

app.use(express.static('./view'));

const server = require('http').createServer(app);


const io = socket(server);


io.on('connection', (socket) => {
    console.log('user connected');
    socket.on('message', (msg) => {
        console.log(msg);
        socket.broadcast.emit('message-broadcast', msg);
    });
    socket.on('chatMessage', (msg) => {
        console.log(msg);
        // add this message to message steam
        io.emit('message', msg);
        // socket.broadcast.emit('message-broadcast', msg);
    });
}
);

const port = process.env.PORT || 5000;

server.listen(port, () => {
    console.log('Server is running on http://localhost:' + port);
}
);
