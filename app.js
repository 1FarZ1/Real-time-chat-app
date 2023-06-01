require('dotenv').config();
const express = require('express');
const socket = require('socket.io');
const messageFormatter = require('./utils/messageFormat');
const morgan = require('morgan');
const { getCurrentUser, userJoin, getRoomUsers,userLeave } = require('./utils/users');



const app = express();

app.use(express.static('./view'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const server = require('http').createServer(app);

const io = socket(server);


io.on('connection', (socket) => {
    console.log('user ' + socket.id + ' connected');
    socket.on('joinRoom', ({ username, room }) => {
        const user = userJoin(socket.id, username, room);
        socket.join(user.room);

        socket.broadcast.to(user.room).emit('message', messageFormatter('Admin', `${user.username} has joined the chat`));

        socket.on('chatMessage', (msg) => {
            const user = getCurrentUser(socket.id);
            io.to(user.room).emit('message', messageFormatter(user.username, msg));
        }

        );

        io.to(user.room).emit("roomUsers", {
            room: user.room,
            users: getRoomUsers(user.room),
          });
        

        socket.on('disconnect', () => {
            const user = userLeave(socket.id);
            if (user) {
                io.to(user.room).emit('message', messageFormatter('Admin', `${user.username} has left the chat`));
            }

            io.to(user.room).emit("roomUsers", {
                room: user.room,
                users: getRoomUsers(user.room),
              });
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
