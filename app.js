require('dotenv').config();
const express = require('express');
const socket = require('socket.io');
const messageFormatter = require('./utils/messageFormat');
const morgan = require('morgan');
const {createClient} = require('redis');
const createAdapter = require("@socket.io/redis-adapter").createAdapter;
const { getCurrentUser, userJoin, getRoomUsers,userLeave } = require('./utils/users');



const app = express();

app.use(express.static('./view'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

(async () => {
    pubClient = createClient({ url: "redis://127.0.0.1:5500" });
    await pubClient.connect();
    subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
  })();

const server = require('http').createServer(app);

const io = socket(server);


let displayRoamInfo = (user) => {

    io.to(user.room).emit("roomUsers", {
        room: user.room,
        users: getRoomUsers(user.room),
      });
}

let number = 0 ;
io.on('connection', (socket) => {
    number++;
    console.log('user ' + socket.id + ' connected');
    console.log(number + ' users connected');
    socket.on('joinRoom', ({ username, room }) => {
        const user = userJoin(socket.id, username, room);
        socket.join(user.room);

        socket.broadcast.to(user.room).emit('message', messageFormatter('Admin', `${user.username} has joined the chat`));

        socket.on('chatMessage', (msg) => {
            const user = getCurrentUser(socket.id);
            io.to(user.room).emit('message', messageFormatter(user.username, msg));
        }
        );
       displayRoamInfo(user);

        socket.on('disconnect', () => {
            const user = userLeave(socket.id);
            if (user) {
                io.to(user.room).emit('message', messageFormatter('Admin', `${user.username} has left the chat`));
            }

            displayRoamInfo(user);
        }
        );            
    }
    );
}
);

const port = process.env.PORT || 5000;

server.listen(port, () => {
    console.log('Server is running on http://localhost:' + port);
}
);
