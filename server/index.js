const fs = require('fs');
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const bodyParser = require('body-parser');
const multer = require('multer');
const FfmpegCommand = require('fluent-ffmpeg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth2').Strategy;
const { google } = require('googleapis');
const db = require('../database/index.js');
const client = require('./client.js');

/**
 * express required to aid in in handeling request made to server
 * session required to aid with passport request for google authentication
 * path required to aid in redirects to avoid landing on incorrect endpoint
 * axios required to send requests
 * bodyParse required to retrieve information from body while avoiding chunks
 * multer required to aid in parsing multiform media, such as audio recordings
 * FfmpegCommand required to convert audio to video
 * passport required in retrieving info from google authentication
 * GoogleStrategy required to retireve user's google infromation to store users
 * google required to upload videos to youtube
 * db required as a path to our database commands
 * client required to authenticate youtube upload requests
 */

require('dotenv').config();

/**
 * app rename to aid in functioncalls
 */

const app = express();

/**
 * upload rename to aid in obtaining audiofiles
 */

const upload = multer();

/**
 * Initialize youtube API library
 */

const youtube = google.youtube({
  version: 'v3',
  auth: client.oAuth2Client,
});


const scopes = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

/**
 * middleware assigned to app to aid in any incoming requests
 */

app.use(express.static(path.join(__dirname, '../dist')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({ secret: 'anything' }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

/**
 * Function created to use user information to access database information
 */

passport.deserializeUser((obj, done) => {
// this function will use the user info to access database info
  done(null, obj);
});

/**
 * Beginning of Google authenticaion
 * passport using newly created instance of GoogleStrategy
 * db.findCreate called after to store information to DB.
 */

passport.use(new GoogleStrategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: 'http://localhost:3000/auth/google/callback',
  passReqToCallback: true,
},
((req, token, tokenSecret, profile, done) => {
  db.findCreate({ googleId: profile.id, displayName: profile.displayName }, (err, user) => done(err, user));
  console.log(profile);
  process.nextTick(() => done(null, profile));
})));

/**
 * Get request calling Google's authenticaion
 * defining the scope of infromation to retrieve
 */
app.get('/auth/google',
  passport.authenticate('google', {
    scope:
            ['email', 'profile'],
  }));

/**
* Get request used to redirect users based on success or failure of login
*/
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: 'http://localhost:3000/login' }),
  (req, res) => {
    res.redirect('http://localhost:3000/mixtape-player');
  });

/**
 * Get request handler used to retrieve users information from request sent to server
 */

app.get('/user/', (req, res) => {
  res.send(req.user);
});

/**
 * Get request handler used to sign user out of application using the request sent to server
 */

app.get('/logout', (req, res) => {
  req.logOut();
  console.log('logged out');
  res.end('logged out');
});

/**
 * Get request handler to db to findCreate user based on response from database
 */

app.get('/getUser', (req, res) => {
  db.findCreate(req.query, (info, response) => {
    console.log(response);
    res.send(response);
  });
});


// get handler to encode sound files into an array buffer for the client

app.get('/soundFile/:file', (req, res) => {
  const { file } = req.params;
  fs.readFile(`./sound/${file}.mp3`, (err, data) => {
    if (err) {
      console.error(err);
      res.send(500);
    } else {
      res.status(200).send(data);
    }
  });
});

/**
 * Get Request handler used to find all playlists from database
 * user information taken from request coming to server
 * return the model found, if found
 */

app.get('/userPlaylists', (req, res) => {
  if (req.user) {
    const { id, displayName } = req.user;
    db.getAllPlaylists({ userId: id }, (info, response) => {
      console.log(response);
      const data = { response, displayName };
      res.send(data);
    });
  }
});

/**
 * Get request used to query database for all public tapes and send
 * the video and styling info to the client
 */

app.get('/public', (req, res) => {
  // if (req.user) {
  db.getAllPlaylists({ isPublic: true }, async (info, response) => {
    try {
      console.log('data', response);
      if (!response.length) {
        res.status(300).send('No public tapes found');
      }
      const data = { response };
      res.status(200).send(data);
    } catch (err) {
      res.status(500);
      console.log(err);
    }
  });
  // }
});

/**
 * Get request handler used to redirect users to mixtape-player endpoint after login
 */

app.get('/', (req, res) => {
  res.redirect('http://localhost:3000/mixtape-player');
});


/**
 * Get request handler used as a catchall to help react router
 * when refreshing on different endpoints, our page would crash.
 * https://tylermcginnis.com/react-router-cannot-get-url-refresh/
 * Read article above for explanation
 */

app.get('/*', (req, res) => {
  if (req.path !== '/auth/google/callback') {
    if (req.path === '/create-mixtapes') {
      if (!req.user) {
        res.redirect('http://localhost:3000/login');
      }
    } else if (req.path === '/') {
      res.redirect('http://localhost:3000/mixtape-player');
    } else {
      res.sendFile(path.join(__dirname, '../dist/index.html'));
    }
  }
});

/**
 * Post Request handler to aid in updating music player
 * orignally made when designing app
 * stretch goal
 */

app.post('/update', (req, res) => {
  // need to figure out how we are sending info to endpoint
  const filter = { userId: 'CHANGE THE FILTER SOMEHOW FILL_ME_IN' };
  const update = { tapeDeck: 'FILL_ME_IN' };
  db.updatePlaylist(filter, update, (response) => {
    console.log(response);
    res.end('Playlist Updated');
  });
});

/**
 * Post request handler to save audio file to disk. There is youtube upload
 * functionality in the comments for later expansion
 */

app.post('/upload', upload.single('recording'), async (req, res) => {
  try {
    const { buffer: recording } = req.file;
    const { id } = req.user;
    const fileName = `${id}-${new Date().toISOString()}`;
    fs.open(`server/audio/${fileName}.ogg`, 'w+', (err, fd) => {
      if (err) {
        res.status(500).send('Could not save recording');
      } else {
        fs.writeFile(fd, recording, (err) => {
          if (err) {
            res.status(500).send('Could not save recording');
          } else {
            fs.readFile(fd, (err, result) => {
              if (err) {
                res.status(500).send('Could not save recording');
              }
              fs.close(fd, (err) => {
                if (err) {
                  res.status(500).send('Could not save recording');
                }
                res.status(201).send(fileName);
              });
            });
          }
        });
      }
    });
    // const outStream = fs.createWriteStream('../testVideo.mp4');
    // const video = new FfmpegCommand(buffer)
    //   .format('ogg')
    //   .input('./server/images/cassette-tape.jpg')
    //   .loop()
    //   .output('outputfile.mp4')
    //   .audioCodec('aac')
    //   .videoCodec('libx264')
    //   .on('error', (err, stdout, stderr) => {
    //     console.error(`Failed to process video: ${err}`);
    //   })
    //   .pipe(outStream, { end: true });
    // client.authenticate(scopes)
    //   .then(async () => {
    //     const result = await youtube.videos.insert(
    //       {
    //         part: 'id,snippet,status',
    //         requestBody: {
    //           snippet: {
    //             title: 'User recording',
    //           },
    //           status: {
    //             privacyStatus: 'private',
    //           },
    //         },
    //         media: {
    //           body: video,
    //         },
    //       },
    //     );
    //     const { data } = result;
    //     res.status(201).json(data);
    //   })
    //   .catch((err) => {
    //     console.error(err);
    //     res.status(500).send('Failed to upload track');
    //   });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to upload track');
  }
});

/**
 * Post Request handler used to collect and store information through db call
 */

app.post('/store', (req, res) => {
  // need to figure out how we are sending info to endpoint
  const {
    userId, aSideLinks, bSideLinks, tapeDeck, tapeLabel, isPublic,
  } = req.body;
  const playlistDetails = {
    userId,
    aSideLinks: JSON.stringify(aSideLinks),
    bSideLinks: JSON.stringify(bSideLinks),
    tapeDeck,
    tapeLabel,
    isPublic,
  };
  // console.log(playlistDetails);
  db.storePlaylist(playlistDetails, (response) => {
    console.log(response);
    res.end('Playlist Stored');
  });
});

/**
 * Post request handler used to git playlist _id number
 * _id is used to sort through playlist when displaying sharable mixtape-player
 * please note the underscore before id
 */

app.post('/getLink', (req, res) => {
  const { key } = req.body;
  const filter = { aSideLinks: key };
  db.retrievePlaylist(filter, (response) => {
    if (response === null) {
      res.end('No Results Found');
    } else {
      res.send({ id: response._id });
    }
  });
});

/**
 * Post request used to load information onto mixtape-player
 * retrieves info from database to render on screen
 */

app.post('/mixtape-player/', (req, res) => {
  // need to do this dynamically
  const { id } = req.body;
  const filter = { _id: id };

  db.updatePlaylist(filter, { $inc: { views: 1 } }, (response) => {
    if (response) {
      console.log('Worked');
    }
  });

  db.retrievePlaylist(filter, (response) => {
    if (response === null) {
      res.end('No Results Found');
    } else {
      const {
        aSideLinks, bSideLinks, tapeDeck, tapeLabel, userId, views,
      } = response;
      const aSide = JSON.parse(aSideLinks);
      let bSide;
      if (bSideLinks) {
        bSide = JSON.parse(bSideLinks);
        const data = {
          aSide,
          bSide,
          tapeDeck,
          tapeLabel,
          userId,
          views,
        };
        res.send(data);
      } else {
        const data = {
          aSide,
          tapeDeck,
          tapeLabel,
          userId,
        };
        res.send(data);
      }
    }
  });
});

app.post('/recording', (req, res) => {
  const { audioId } = req.body;
  fs.readFile(`./server/audio/${audioId}.ogg`, { encoding: 'base64' }, (err, data) => {
    if (err) {
      console.error(err);
      res.send(500).send('Could not retrieve recording');
    } else {
      res.status(200).send(data);
    }
  });
});

/**
 * Post request used to search information based on user input
 * axios.get request sent to google's api to retrieve snippet from youtube containing music
 */

app.post('/search', (req, res) => {
  const queryString = req.body.query;
  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet';
  const options = {
    params: {
      key: process.env.YOUTUBE_API_KEY,
      q: queryString,
      maxResults: 10,
      videoEmbeddable: true,
      type: 'video',
    },
  };
  axios.get(url, options)
    .then((response) => {
      res.send(response.data);
    })
    .catch((err) => {
      console.log('Error searching youtube:', err);
      res.send(err);
    });
});

app.post('/new-view', (req, res) => {
  const { id } = req.body;
  console.log(id);
  db.updatePlaylist({ _id: id }, { $inc: { views: 1 } }, (response) => {
    console.log('Ok');
    res.status(200).send({ views: response.views });
  });
});


const PORT = 3000;

app.listen(PORT, () => console.log(`Your app is sparkling on port ${PORT}!`));
